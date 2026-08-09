import { Router, Request, Response } from 'express';
import { getDB } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();
const db = getDB();

const TurnoAperturaSchema = z.object({
  caja_id: z.string().uuid(),
  sucursal_id: z.string().uuid(),
  usuario_id: z.string().uuid(),
  monto_apertura: z.number().min(0),
});

const TurnoCierreSchema = z.object({
  monto_contado: z.number().min(0),
});

// ── Ledger de caja: fuente única para arqueo y disponibilidad ────────────────
// El efectivo FÍSICO esperado en el cajón se deriva SIEMPRE de los movimientos
// registrados (no de las ventas), porque ahí están también las devoluciones
// (DEVOLUCION = monto negativo) y los retiros/depósitos. Venta en un mismo
// criterio que el cliente para que arqueo y resumen nunca divergan.
interface CashLedger {
  sales: number;
  refunds: number;
  deposits: number;
  withdrawals: number;
}

function getCashLedger(turnoId: string): CashLedger {
  const movs = db.prepare(`
    SELECT tipo, monto FROM movimientos_caja
    WHERE turno_id = ? AND tipo IN ('VENTA_EFECTIVO', 'DEVOLUCION', 'DEPOSITO', 'RETIRO')
  `).all(turnoId) as Array<{ tipo: string; monto: number }>;

  const ledger: CashLedger = { sales: 0, refunds: 0, deposits: 0, withdrawals: 0 };
  for (const m of movs) {
    if (m.tipo === 'VENTA_EFECTIVO') ledger.sales += m.monto;
    else if (m.tipo === 'DEVOLUCION') ledger.refunds += m.monto; // negativo: efectivo devuelto al cliente
    else if (m.tipo === 'DEPOSITO') ledger.deposits += m.monto;
    else if (m.tipo === 'RETIRO') ledger.withdrawals += m.monto;
  }
  return ledger;
}

function expectedCash(turno: { monto_apertura: number }, ledger: CashLedger): number {
  return turno.monto_apertura + ledger.sales + ledger.refunds + ledger.deposits - ledger.withdrawals;
}

// Los retiros sacan dinero físico del cajón: exigen autorización de supervisor,
// registrada en `autorizado_por`. Se valida la identidad y el rol aquí mismo
// (defensa en profundidad — el flujo de UI ya pide PIN).
function isAuthorizedSupervisor(autorizadoPor: unknown): boolean {
  if (typeof autorizadoPor !== 'string' || !autorizadoPor) return false;
  const u = db.prepare('SELECT role FROM usuarios WHERE id = ? AND activa = 1').get(autorizadoPor) as { role: string } | undefined;
  return !!u && ['SUPERVISOR', 'ADMIN', 'MANAGER'].includes(u.role);
}

// POST /api/turnos - Abrir turno
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const data = TurnoAperturaSchema.parse(req.body);

    if (data.usuario_id !== user.userId && user.role !== 'ADMIN') {
      res.status(403).json({ error: 'No puede abrir turno para otro usuario' });
      return;
    }

    // Verificar que no haya turno abierto en la caja
    const abierto = db.prepare('SELECT id FROM turnos WHERE caja_id = ? AND estado = \'ABIERTO\'').get(data.caja_id);
    if (abierto) {
      res.status(400).json({ error: 'Ya hay un turno abierto en esta caja' });
      return;
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO turnos (id, caja_id, sucursal_id, usuario_id, monto_apertura, estado, opened_at)
      VALUES (?, ?, ?, ?, ?, 'ABIERTO', ?)
    `).run(id, data.caja_id, data.sucursal_id, data.usuario_id, data.monto_apertura, now);

    // Movimiento de apertura
    db.prepare(`
      INSERT INTO movimientos_caja (id, turno_id, tipo, monto)
      VALUES (?, ?, 'APERTURA', ?)
    `).run(uuidv4(), id, data.monto_apertura);

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'OPEN_SHIFT', 'turno', ?, ?)
    `).run(uuidv4(), user.userId, id, JSON.stringify({ monto_apertura: data.monto_apertura }));

    res.status(201).json({ id, ...data, opened_at: now });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Datos inválidos', details: error.errors });
      return;
    }
    res.status(500).json({ error: 'Error abriendo turno' });
  }
});

// GET /api/turnos - Listar turnos
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { sucursal_id, caja_id, estado, usuario_id, limit = '50', offset = '0' } = req.query;

    let sql = `
      SELECT t.*, c.nombre as caja_nombre, u.nombre as usuario_nombre,
        (SELECT COUNT(*) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'PAGADA') as ventas_count,
        (SELECT COALESCE(SUM(v.total),0) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'PAGADA') as totalVentas,
        (SELECT COALESCE(SUM(v.total),0) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'PAGADA' AND v.metodo_pago = 'EFECTIVO') as ventasEfectivo,
        (SELECT COALESCE(SUM(v.total),0) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'PAGADA' AND v.metodo_pago = 'TARJETA') as ventasTarjeta
      FROM turnos t
      JOIN cajas c ON c.id = t.caja_id
      JOIN usuarios u ON u.id = t.usuario_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (sucursal_id) { sql += ' AND t.sucursal_id = ?'; params.push(sucursal_id); }
    else if (user.role !== 'ADMIN') { sql += ' AND t.sucursal_id = ?'; params.push(user.sucursalId); }

    if (caja_id) { sql += ' AND t.caja_id = ?'; params.push(caja_id); }
    if (estado) { sql += ' AND t.estado = ?'; params.push(estado); }
    if (usuario_id) { sql += ' AND t.usuario_id = ?'; params.push(usuario_id); }

    sql += ' ORDER BY t.opened_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));

    const turnos = db.prepare(sql).all(...params);
    res.json(turnos);
  } catch (error) {
    res.status(500).json({ error: 'Error listando turnos' });
  }
});

// GET /api/turnos/abierto/:cajaId - Obtener turno abierto de una caja
router.get('/abierto/:cajaId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const turno = db.prepare('SELECT * FROM turnos WHERE caja_id = ? AND estado = \'ABIERTO\'').get(req.params.cajaId);
    if (!turno) {
      res.json({ turno: null });
      return;
    }
    res.json({ turno });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo turno' });
  }
});

// GET /api/turnos/:id - Obtener turno con detalles
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const turno = db.prepare(`
      SELECT t.*, c.nombre as caja_nombre, u.nombre as usuario_nombre
      FROM turnos t
      JOIN cajas c ON c.id = t.caja_id
      JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.id = ?
    `).get(req.params.id);

    if (!turno) {
      res.status(404).json({ error: 'Turno no encontrado' });
      return;
    }

    // Ventas del turno
    const ventas = db.prepare('SELECT * FROM ventas WHERE turno_id = ? AND estado = \'PAGADA\'').all(req.params.id);
const totalVentas = ventas.reduce((sum: number, v: any) => sum + v.total, 0);
const ventasEfectivo = ventas.filter((v: any) => v.metodo_pago === 'EFECTIVO').reduce((sum: number, v: any) => sum + v.total, 0);
const ventasTarjeta = ventas.filter((v: any) => v.metodo_pago === 'TARJETA').reduce((sum: number, v: any) => sum + v.total, 0);

    // Movimientos de caja
    const movimientos = db.prepare('SELECT * FROM movimientos_caja WHERE turno_id = ? ORDER BY created_at').all(req.params.id);

    res.json({ ...turno, ventas, totalVentas, ventasEfectivo, ventasTarjeta, movimientos });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo turno' });
  }
});

// POST /api/turnos/:id/cerrar - Cerrar turno (arqueo)
router.post('/:id/cerrar', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const data = TurnoCierreSchema.parse(req.body);

    const turno = db.prepare('SELECT * FROM turnos WHERE id = ? AND estado = \'ABIERTO\'').get(req.params.id);
    if (!turno) {
      res.status(404).json({ error: 'Turno no encontrado o ya cerrado' });
      return;
    }

    if (turno.usuario_id !== user.userId && user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') {
      res.status(403).json({ error: 'No autorizado para cerrar este turno' });
      return;
    }

    // Calcular esperado desde el ledger de caja (fuente única)
    const totalEfectivo = Number(db.prepare(`
      SELECT COALESCE(SUM(total), 0) as t FROM ventas
      WHERE turno_id = ? AND estado = 'PAGADA' AND metodo_pago = 'EFECTIVO'
    `).get(String(req.params.id)).t ?? 0);
    const totalTarjeta = Number(db.prepare(`
      SELECT COALESCE(SUM(total), 0) as t FROM ventas
      WHERE turno_id = ? AND estado = 'PAGADA' AND metodo_pago = 'TARJETA'
    `).get(String(req.params.id)).t ?? 0);
    const esperado = expectedCash(turno, getCashLedger(String(req.params.id)));
    const diferencia = data.monto_contado - esperado;
    const flagged = Math.abs(diferencia) > 1.00;

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE turnos SET
        estado = ?,
        monto_esperado = ?,
        monto_contado = ?,
        diferencia = ?,
        closed_at = ?
      WHERE id = ?
    `).run(flagged ? 'CON_DESCUADRE' : 'CERRADO', esperado, data.monto_contado, diferencia, now, req.params.id);

    // Movimiento de cierre
    db.prepare(`
      INSERT INTO movimientos_caja (id, turno_id, tipo, monto)
      VALUES (?, ?, 'CIERRE', ?)
    `).run(uuidv4(), req.params.id, data.monto_contado);

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'CLOSE_SHIFT', 'turno', ?, ?)
    `).run(uuidv4(), user.userId, req.params.id, JSON.stringify({
      esperado,
      contado: data.monto_contado,
      diferencia,
      flagged,
      total_ventas: totalEfectivo + totalTarjeta,
      ventas_efectivo: totalEfectivo,
      ventas_tarjeta: totalTarjeta,
    }));

    res.json({
      success: true,
      turno_id: req.params.id,
      esperado,
      contado: data.monto_contado,
      diferencia,
      flagged,
      total_ventas: totalEfectivo + totalTarjeta,
      ventas_efectivo: totalEfectivo,
      ventas_tarjeta: totalTarjeta,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Datos inválidos', details: error.errors });
      return;
    }
    res.status(500).json({ error: 'Error cerrando turno' });
  }
});

// POST /api/turnos/:id/movimiento - Agregar movimiento de caja (retiro/depósito)
router.post('/:id/movimiento', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { tipo, monto, motivo, autorizado_por } = req.body;

    if (!['RETIRO', 'DEPOSITO'].includes(tipo)) {
      res.status(400).json({ error: 'Tipo inválido' });
      return;
    }

    if (typeof monto !== 'number' || !Number.isFinite(monto) || monto <= 0) {
      res.status(400).json({ error: 'El monto debe ser un número mayor a cero' });
      return;
    }

    // Los retiros sacan del cajón: exigen autorización de supervisor (defensa en profundidad)
    if (tipo === 'RETIRO' && !isAuthorizedSupervisor(autorizado_por)) {
      res.status(403).json({ error: 'Retiro no autorizado: se requiere autorización de supervisor' });
      return;
    }

    const turno = db.prepare('SELECT * FROM turnos WHERE id = ? AND estado = \'ABIERTO\'').get(req.params.id);
    if (!turno) {
      res.status(404).json({ error: 'Turno no encontrado o no está abierto' });
      return;
    }

    if (tipo === 'RETIRO') {
      // Verificar que hay suficiente efectivo físico según el ledger (incluye devoluciones)
      const ledger = getCashLedger(String(req.params.id));
      const disponible = expectedCash(turno, ledger);
      if (monto > disponible) {
        res.status(400).json({ error: 'Efectivo insuficiente', disponible });
        return;
      }
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO movimientos_caja (id, turno_id, tipo, monto, motivo, autorizado_por)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, tipo, monto, motivo ?? null, autorizado_por ?? null);

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, ?, 'movimiento_caja', ?, ?)
    `).run(uuidv4(), user.userId, tipo, id, JSON.stringify({ monto, motivo }));

    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: 'Error agregando movimiento' });
  }
});

export default router;