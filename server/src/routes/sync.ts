import { Router, Request, Response } from 'express';
import { getDB } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { getCashLedger, expectedCash, isAuthorizedSupervisor } from './turnos.js';

const router = Router();
const db = getDB();

// ── Defensas del canal offline ───────────────────────────────────────────────
// El push de sync es un camino ALTERNO por el que entra dinero a la BD. Antes
// no tenía ninguna de las validaciones de la ruta online (/ventas, /turnos),
// así que un cajero podía registrar retiros sin autorización o ventas a precio
// fabricado. Aquí se aplican las MISMAS reglas que en el canal online.

const METODOS_PAGO = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'MIXTO'] as const;
const TIPOS_MOVIMIENTO_CAJA = ['VENTA_EFECTIVO', 'DEVOLUCION', 'DEPOSITO', 'RETIRO'] as const;
const TIPOS_MOVIMIENTO_STOCK = ['ENTRADA', 'SALIDA', 'AJUSTE', 'TRANSFERENCIA', 'VENCIMIENTO', 'DEVOLUCION'] as const;

// El payload de un POS offline debe pertenecer a la sucursal del token.
function validarSucursal(payload: Record<string, unknown>, user: { sucursalId: string; role: string }): void {
  const sucursalId = (payload.sucursal_id ?? payload.sucursalId) as string | undefined;
  if (!sucursalId) throw new Error('Falta sucursal_id en la operación');
  if (sucursalId !== user.sucursalId && user.role !== 'ADMIN') {
    throw new Error('La operación no pertenece a la sucursal del usuario');
  }
}

function turnoAbierto(turnoId: string): { id: string; caja_id: string; sucursal_id: string; usuario_id: string; monto_apertura: number } {
  const turno = db.prepare('SELECT * FROM turnos WHERE id = ? AND estado = \'ABIERTO\'').get(turnoId) as    { id: string; caja_id: string; sucursal_id: string; usuario_id: string; monto_apertura: number } | undefined;
  if (!turno) throw new Error('Turno no encontrado o no está abierto');
  return turno;
}

// Health check
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// POST /api/sync/push - Recibir operaciones del POS
router.post('/push', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { caja_id, operaciones } = req.body;

    if (!caja_id || !Array.isArray(operaciones)) {
      res.status(400).json({ error: 'caja_id y operaciones requeridos' });
      return;
    }

    const startTime = Date.now();
    let procesados = 0;
    let errores = 0;
    const detalles: any[] = [];

    for (const op of operaciones) {
      try {
        await procesarOperacion(op, user);
        procesados++;
      } catch (error) {
        errores++;
        detalles.push({ operacion: op.tipo, error: error instanceof Error ? error.message : 'Error' });
      }
    }

    // Log sync
    db.prepare(`
      INSERT INTO sync_log (id, caja_id, tipo, registros_enviados, registros_recibidos, conflictos, estado, duracion_ms)
      VALUES (?, ?, 'PUSH', ?, ?, 0, ?, ?)
    `).run(uuidv4(), req.body.caja_id, procesados, errores, errores === 0 ? 'EXITOSO' : (procesados > 0 ? 'PARCIAL' : 'FALLIDO'), Date.now() - startTime);

    res.json({ procesados, errores, detalles });
  } catch (error) {
    console.error('[Sync Push] Error:', error);
    res.status(500).json({ error: 'Error en sync push' });
  }
});

async function procesarOperacion(op: any, user: any): Promise<void> {
  const { tipo, payload } = op;

  switch (tipo) {
    case 'CREATE_SALE':
      await crearVentaServer(payload, user);
      break;
    case 'CREATE_SHIFT':
      await crearTurnoServer(payload, user);
      break;
    case 'CLOSE_SHIFT':
      await cerrarTurnoServer(payload, user);
      break;
    case 'CREATE_STOCK_MOVEMENT':
      await crearMovimientoStockServer(payload, user);
      break;
    case 'CREATE_CASH_MOVEMENT':
      await crearMovimientoCajaServer(payload, user);
      break;
    case 'CREATE_AUDIT_LOG':
      await crearAuditoriaServer(payload);
      break;
    default:
      throw new Error(`Tipo de operación desconocido: ${tipo}`);
  }
}

// ── Ventas: mismas reglas que POST /api/ventas ───────────────────────────────
// Precio e impuesto SIEMPRE desde el catálogo maestro; stock con guarda
// atómica; el total de la venta lo calcula el servidor.
async function crearVentaServer(payload: any, user: any): Promise<void> {
  const {
    id, turno_id, caja_id, sucursal_id, usuario_id,
    metodo_pago, codigo_autorizacion, detalles, created_at,
  } = payload;

  if (!id) throw new Error('Falta id de la venta');
  validarSucursal({ sucursal_id }, user);

  const existe = db.prepare('SELECT id FROM ventas WHERE id = ?').get(id);
  if (existe) return; // Ya sincronizada

  if (!METODOS_PAGO.includes(metodo_pago)) throw new Error('Metodo de pago inválido');
  const turno = turnoAbierto(turno_id);
  if (turno.sucursal_id !== sucursal_id) throw new Error('La venta no pertenece al turno indicado');
  if (!caja_id) throw new Error('Falta caja_id');

  if (!Array.isArray(detalles) || detalles.length === 0) {
    throw new Error('Detalles de venta requeridos');
  }

  // El vendedor debe ser un usuario real y activo de la sucursal del turno.
  if (usuario_id) {
    const vendedor = db.prepare('SELECT id, sucursal_id, activa FROM usuarios WHERE id = ?').get(usuario_id) as
      { id: string; sucursal_id: string; activa: number } | undefined;
    if (!vendedor || vendedor.activa !== 1 || vendedor.sucursal_id !== turno.sucursal_id) {
      throw new Error('Vendedor inválido para esta sucursal');
    }
  }

  // ── Recalcular contra catálogo maestro (no se confía en total/subtotal) ──
  const masterRows = detalles.map((det: any) => {
    const cantidad = Number(det.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1) throw new Error('Cantidad de detalle inválida');
    if (!det.producto_id) throw new Error('Detalle sin producto_id');

    const prod = db.prepare('SELECT id, precio, impuesto, nombre, activo FROM productos WHERE id = ?').get(det.producto_id) as
      { id: string; precio: number; impuesto: number; nombre: string; activo: number } | undefined;
    if (!prod || prod.activo !== 1) throw new Error(`Producto no encontrado o inactivo (${det.producto_id})`);
    return { producto_id: det.producto_id, cantidad, lote_id: det.lote_id ?? null, prod };
  });

  let subtotal = 0;
  let impuestos = 0;
  for (const m of masterRows) {
    const line = m.prod.precio * m.cantidad;
    subtotal += line;
    impuestos += line * m.prod.impuesto;
  }
  const total = Math.round((subtotal + impuestos) * 100) / 100;
  const now = created_at ?? new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO ventas (id, turno_id, caja_id, sucursal_id, usuario_id, metodo_pago, codigo_autorizacion, subtotal, impuestos, total, estado, synced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAGADA', ?, ?)
    `).run(id, turno_id, caja_id, turno.sucursal_id, usuario_id ?? user.userId, metodo_pago, codigo_autorizacion ?? null, subtotal, impuestos, total, now, now);

    for (const m of masterRows) {
      const detId = uuidv4();
      const detSubtotal = m.prod.precio * m.cantidad;
      db.prepare(`
        INSERT INTO venta_detalles (id, venta_id, producto_id, cantidad, precio_unitario, impuesto, subtotal, lote_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(detId, id, m.producto_id, m.cantidad, m.prod.precio, m.prod.impuesto, detSubtotal, m.lote_id);

      // Descuento condicional: evita stock negativo en condiciones de carrera
      const stockRes = db.prepare(`
        UPDATE stock_sucursal SET cantidad = cantidad - ?
        WHERE producto_id = ? AND sucursal_id = ? AND cantidad >= ?
      `).run(m.cantidad, m.producto_id, turno.sucursal_id, m.cantidad);
      if (stockRes.changes === 0) {
        throw new Error(`Stock insuficiente para el producto ${m.producto_id}`);
      }

      db.prepare(`
        INSERT INTO movimientos_stock (id, producto_id, sucursal_id, tipo, cantidad, motivo, referencia_id, usuario_id)
        VALUES (?, ?, ?, 'SALIDA', ?, 'VENTA', ?, ?)
      `).run(uuidv4(), m.producto_id, turno.sucursal_id, m.cantidad, id, user.userId);
    }

    // Movimiento caja
    const montoEfectivo = metodo_pago === 'EFECTIVO' ? total : (metodo_pago === 'MIXTO' ? total / 2 : 0);
    if (montoEfectivo > 0) {
      db.prepare(`
        INSERT INTO movimientos_caja (id, turno_id, tipo, monto, referencia_id)
        VALUES (?, ?, 'VENTA_EFECTIVO', ?, ?)
      `).run(uuidv4(), turno_id, montoEfectivo, id);
    }
  });

  tx();
}

// ── Turnos: solo el titular (o ADMIN) puede abrir para sí mismo ──────────────
async function crearTurnoServer(payload: any, user: any): Promise<void> {
  const { id, caja_id, sucursal_id, usuario_id, monto_apertura, opened_at } = payload;
  if (!id || !caja_id || !sucursal_id) throw new Error('Faltan datos del turno');

  validarSucursal({ sucursal_id }, user);

  // Misma regla que POST /api/turnos: no abrir turno bajo el nombre de otro
  if (usuario_id !== user.userId && user.role !== 'ADMIN') {
    throw new Error('No puede abrir turno para otro usuario');
  }

  if (typeof monto_apertura !== 'number' || !Number.isFinite(monto_apertura) || monto_apertura < 0) {
    throw new Error('Monto de apertura inválido');
  }

  // La caja debe existir y pertenecer a la sucursal
  const caja = db.prepare('SELECT id, sucursal_id FROM cajas WHERE id = ?').get(caja_id) as { id: string; sucursal_id: string } | undefined;
  if (!caja || caja.sucursal_id !== sucursal_id) throw new Error('Caja inválida para la sucursal');

  const existe = db.prepare('SELECT id FROM turnos WHERE id = ?').get(id);
  if (existe) return;

  const abierto = db.prepare('SELECT id FROM turnos WHERE caja_id = ? AND estado = \'ABIERTO\'').get(caja_id);
  if (abierto) throw new Error('Ya hay un turno abierto en esta caja');

  db.prepare(`
    INSERT INTO turnos (id, caja_id, sucursal_id, usuario_id, monto_apertura, estado, opened_at)
    VALUES (?, ?, ?, ?, ?, 'ABIERTO', ?)
  `).run(id, caja_id, sucursal_id, usuario_id, monto_apertura, opened_at ?? new Date().toISOString());

  db.prepare(`
    INSERT INTO movimientos_caja (id, turno_id, tipo, monto)
    VALUES (?, ?, 'APERTURA', ?)
  `).run(uuidv4(), id, monto_apertura);

  db.prepare(`
    INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
    VALUES (?, ?, 'OPEN_SHIFT', 'turno', ?, ?)
  `).run(uuidv4(), user.userId, id, JSON.stringify({ monto_apertura }));
}

// ── Cierre: el esperado/descuadre lo calcula SIEMPRE el servidor ─────────────
// El POS offline solo aporta el monto contado; no se confía en monto_esperado,
// diferencia ni flagged que envíe el cliente.
async function cerrarTurnoServer(payload: any, user: any): Promise<void> {
  const { id, monto_contado } = payload;
  if (!id) throw new Error('Falta id del turno');
  if (typeof monto_contado !== 'number' || !Number.isFinite(monto_contado) || monto_contado < 0) {
    throw new Error('Monto contado inválido');
  }

  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(id) as
    { id: string; estado: string; monto_apertura: number } | undefined;
  if (!turno) throw new Error('Turno no encontrado');
  if (turno.estado !== 'ABIERTO') return; // ya cerrado: idempotente

  const esperado = expectedCash(turno, getCashLedger(id));
  const diferencia = monto_contado - esperado;
  const flagged = Math.abs(diferencia) > 1.00;
  const closed_at = payload.closed_at ?? new Date().toISOString();

  db.prepare(`
    UPDATE turnos SET
      estado = ?,
      monto_esperado = ?,
      monto_contado = ?,
      diferencia = ?,
      closed_at = ?
    WHERE id = ?
  `).run(flagged ? 'CON_DESCUADRE' : 'CERRADO', esperado, monto_contado, diferencia, closed_at, id);

  db.prepare(`
    INSERT INTO movimientos_caja (id, turno_id, tipo, monto)
    VALUES (?, ?, 'CIERRE', ?)
  `).run(uuidv4(), id, monto_contado);

  db.prepare(`
    INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
    VALUES (?, ?, 'CLOSE_SHIFT', 'turno', ?, ?)
  `).run(uuidv4(), user.userId, id, JSON.stringify({ esperado, contado: monto_contado, diferencia, flagged }));
}

// ── Movimientos de caja: retiro exige autorización y disponibilidad ──────────
async function crearMovimientoCajaServer(payload: any, user: any): Promise<void> {
  const { id, turno_id, tipo, monto, motivo, autorizado_por, referencia_id, created_at } = payload;
  if (!id || !turno_id) throw new Error('Faltan datos del movimiento de caja');
  if (!TIPOS_MOVIMIENTO_CAJA.includes(tipo)) throw new Error(`Tipo de movimiento de caja no permitido: ${tipo}`);

  if (typeof monto !== 'number' || !Number.isFinite(monto)) throw new Error('Monto inválido');
  // DEVOLUCION es dinero que SALE del cajón hacia el cliente: estrictamente
  // negativo. Dejar pasar una DEVOLUCION positiva inflaría el esperado del
  // arqueo y permitiría cuadrar retirando efectivo.
  if (tipo === 'DEVOLUCION') {
    if (monto >= 0) throw new Error('Una devolución debe ser un monto negativo');
  } else if (monto <= 0) {
    throw new Error('El monto debe ser mayor a cero');
  }

  const turno = turnoAbierto(turno_id);

  // Los retiros sacan efectivo físico: exigen autorización de supervisor y
  // disponibilidad según el ledger (misma defensa que POST /turnos/:id/movimiento).
  if (tipo === 'RETIRO') {
    if (!isAuthorizedSupervisor(autorizado_por)) {
      throw new Error('Retiro no autorizado: se requiere autorización de supervisor');
    }
    const disponible = expectedCash(turno, getCashLedger(turno_id));
    if (monto > disponible) {
      throw new Error(`Efectivo insuficiente: disponible ${disponible}`);
    }
  }

  // El movimiento debe pertenecer al turno de la sucursal del usuario
  if (turno.sucursal_id !== user.sucursalId && user.role !== 'ADMIN') {
    throw new Error('Movimiento no pertenece a la sucursal del usuario');
  }

  const existe = db.prepare('SELECT id FROM movimientos_caja WHERE id = ?').get(id);
  if (existe) return;

  db.prepare(`
    INSERT INTO movimientos_caja (id, turno_id, tipo, monto, motivo, autorizado_por, referencia_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, turno_id, tipo, monto, motivo ?? null, autorizado_por ?? null, referencia_id ?? null, created_at ?? new Date().toISOString());

  db.prepare(`
    INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
    VALUES (?, ?, ?, 'movimiento_caja', ?, ?)
  `).run(uuidv4(), user.userId, tipo, id, JSON.stringify({ monto, motivo }));
}

// ── Movimientos de stock: solo de la propia sucursal y con tipo válido ───────
async function crearMovimientoStockServer(payload: any, user: any): Promise<void> {
  const { id, producto_id, sucursal_id, tipo, cantidad, motivo, referencia_id, usuario_id, created_at } = payload;
  if (!id || !producto_id || !sucursal_id) throw new Error('Faltan datos del movimiento de stock');

  validarSucursal({ sucursal_id }, user);
  if (!TIPOS_MOVIMIENTO_STOCK.includes(tipo)) throw new Error(`Tipo de movimiento de stock no permitido: ${tipo}`);
  if (typeof cantidad !== 'number' || !Number.isFinite(cantidad) || cantidad < 0) throw new Error('Cantidad inválida');

  const existe = db.prepare('SELECT id FROM movimientos_stock WHERE id = ?').get(id);
  if (existe) return;

  db.prepare(`
    INSERT INTO movimientos_stock (id, producto_id, sucursal_id, tipo, cantidad, motivo, referencia_id, usuario_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, producto_id, sucursal_id, tipo, cantidad, motivo ?? null, referencia_id ?? null, usuario_id ?? user.userId, created_at ?? new Date().toISOString());
}

async function crearAuditoriaServer(payload: any): Promise<void> {
  const { id, usuario_id, accion, entidad, entidad_id, metadatos, ip, user_agent, created_at } = payload;
  if (!id || !usuario_id || !accion) throw new Error('Faltan datos de auditoría');

  const existe = db.prepare('SELECT id FROM auditoria WHERE id = ?').get(id);
  if (existe) return;

  db.prepare(`
    INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, usuario_id, accion, entidad ?? null, entidad_id ?? null, metadatos ?? null, ip ?? null, user_agent ?? null, created_at ?? new Date().toISOString());
}

// Interpreta `since` (ms como string o ISO). Nunca `new Date(string)` directo:
// un string numérico tipo "1756..." es Invalid Date y rompería el pull.
function parseSince(since: unknown): Date {
  if (since === undefined || since === '') return new Date(0);
  const n = Number(since);
  const parsed = Number.isFinite(n) ? new Date(n) : new Date(String(since));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

// GET /api/sync/pull - Enviar cambios al POS
router.get('/pull', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { caja_id, since } = req.query;

    if (!caja_id) {
      res.status(400).json({ error: 'caja_id requerido' });
      return;
    }

    // `since` viaja como ms (número en string) o ISO. Nunca lo parsees con
    // `new Date(string)` a secas: "1756..." como string es Invalid Date y el
    // pull explota en el primer reconnect con since > 0.
    const sinceDate = parseSince(since);

    // La caja debe pertenecer a la sucursal del usuario
    const caja = db.prepare('SELECT id, sucursal_id FROM cajas WHERE id = ?').get(caja_id) as { id: string; sucursal_id: string } | undefined;
    if (!caja || (caja.sucursal_id !== user.sucursalId && user.role !== 'ADMIN')) {
      res.status(403).json({ error: 'Caja no autorizada' });
      return;
    }

    // Productos actualizados (la columna es updated_at; sucursal vía stock_sucursal)
    const productos = db.prepare(`
      SELECT p.* FROM productos p
      WHERE p.updated_at > ?
    `).all(sinceDate.toISOString());

    // Stock
    const stock = db.prepare(`
      SELECT ss.*, p.nombre, p.sku, p.barcode
      FROM stock_sucursal ss
      JOIN productos p ON p.id = ss.producto_id
      WHERE ss.sucursal_id = ?
    `).all(caja.sucursal_id);

    // Lotes
    const lotes = db.prepare(`
      SELECT * FROM lotes WHERE sucursal_id = ? AND cantidad > 0
    `).all(caja.sucursal_id);

    // Usuarios
    const usuarios = db.prepare(`
      SELECT id, nombre, email, role FROM usuarios WHERE sucursal_id = ? AND activa = 1
    `).all(caja.sucursal_id);

    res.json({
      timestamp: new Date().toISOString(),
      productos,
      stock,
      lotes,
      usuarios,
    });
  } catch (error) {
    console.error('[Sync Pull] Error:', error);
    res.status(500).json({ error: 'Error en sync pull' });
  }
});

// GET /api/sync/status - Estado de sincronización de una caja
router.get('/status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { caja_id } = req.query;
    if (!caja_id) {
      res.status(400).json({ error: 'caja_id requerido' });
      return;
    }

    const caja = db.prepare('SELECT id, nombre, estado, last_sync, sucursal_id FROM cajas WHERE id = ?').get(caja_id) as
      { id: string; nombre: string; estado: string; last_sync: string | null; sucursal_id: string } | undefined;
    if (!caja) {
      res.status(404).json({ error: 'Caja no encontrada' });
      return;
    }
    if (caja.sucursal_id !== user.sucursalId && user.role !== 'ADMIN') {
      res.status(403).json({ error: 'Caja no autorizada' });
      return;
    }

    const lastSync = db.prepare('SELECT * FROM sync_log WHERE caja_id = ? ORDER BY created_at DESC LIMIT 1').get(caja_id);
    // outbox solo existe en el POS offline; acá las operaciones pendientes se
    // derivan de sync_log para no depender de una tabla inexistente.
    const pendingOps = db.prepare(`
      SELECT COUNT(*) as count FROM sync_log
      WHERE caja_id = ? AND estado IN ('PARCIAL', 'FALLIDO')
    `).get(caja_id) as { count: number };

    res.json({
      caja: { ...caja, last_sync: caja.last_sync },
      last_sync_log: lastSync,
      pending_operations: pendingOps.count,
    });
  } catch (error) {
    console.error('[Sync Status] Error:', error);
    res.status(500).json({ error: 'Error obteniendo estado sync' });
  }
});

export default router;
