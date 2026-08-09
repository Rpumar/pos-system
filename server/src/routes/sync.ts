import { Router, Request, Response } from 'express';
import { getDB } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();
const db = getDB();

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
  const { tipo, payload, id: opId } = op;

  switch (tipo) {
    case 'CREATE_SALE':
      await crearVentaServer(payload);
      break;
    case 'CREATE_SHIFT':
      await crearTurnoServer(payload);
      break;
    case 'CLOSE_SHIFT':
      await cerrarTurnoServer(payload);
      break;
    case 'CREATE_STOCK_MOVEMENT':
      await crearMovimientoStockServer(payload);
      break;
    case 'CREATE_CASH_MOVEMENT':
      await crearMovimientoCajaServer(payload);
      break;
    case 'CREATE_AUDIT_LOG':
      await crearAuditoriaServer(payload);
      break;
    default:
      throw new Error(`Tipo de operación desconocido: ${tipo}`);
  }
}

async function crearVentaServer(payload: any): Promise<void> {
  const { id, turno_id, caja_id, sucursal_id, usuario_id, metodo_pago, codigo_autorizacion, detalles, total, subtotal, impuestos, created_at } = payload;

  const existe = db.prepare('SELECT id FROM ventas WHERE id = ?').get(id);
  if (existe) return; // Ya sincronizada

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO ventas (id, turno_id, caja_id, sucursal_id, usuario_id, metodo_pago, codigo_autorizacion, subtotal, impuestos, total, estado, synced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAGADA', ?, ?)
    `).run(id, turno_id, caja_id, sucursal_id, usuario_id, metodo_pago, codigo_autorizacion ?? null, subtotal ?? 0, impuestos ?? 0, total, created_at, created_at);

    for (const det of detalles) {
      const detId = uuidv4();
      const detSubtotal = det.precio_unitario * det.cantidad;
      db.prepare(`
        INSERT INTO venta_detalles (id, venta_id, producto_id, cantidad, precio_unitario, impuesto, subtotal, lote_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(detId, id, det.producto_id, det.cantidad, det.precio_unitario, det.impuesto ?? 0.21, detSubtotal, det.lote_id ?? null);

      db.prepare(`
        UPDATE stock_sucursal SET cantidad = cantidad - ? WHERE producto_id = ? AND sucursal_id = ?
      `).run(det.cantidad, det.producto_id, sucursal_id);
    }

    if (metodo_pago === 'EFECTIVO' || metodo_pago === 'MIXTO') {
      const montoEfectivo = metodo_pago === 'EFECTIVO' ? total : total / 2;
      db.prepare(`
        INSERT INTO movimientos_caja (id, turno_id, tipo, monto, referencia_id)
        VALUES (?, ?, 'VENTA_EFECTIVO', ?, ?)
      `).run(uuidv4(), turno_id, montoEfectivo, id);
    }
  });

  tx();
}

async function crearTurnoServer(payload: any): Promise<void> {
  const { id, caja_id, sucursal_id, usuario_id, monto_apertura, opened_at } = payload;

  const existe = db.prepare('SELECT id FROM turnos WHERE id = ?').get(id);
  if (existe) return;

  db.prepare(`
    INSERT INTO turnos (id, caja_id, sucursal_id, usuario_id, monto_apertura, estado, opened_at)
    VALUES (?, ?, ?, ?, ?, 'ABIERTO', ?)
  `).run(id, caja_id, sucursal_id, usuario_id, monto_apertura, opened_at);

  db.prepare(`
    INSERT INTO movimientos_caja (id, turno_id, tipo, monto)
    VALUES (?, ?, 'APERTURA', ?)
  `).run(uuidv4(), id, monto_apertura);
}

async function cerrarTurnoServer(payload: any): Promise<void> {
  const { id, monto_contado, monto_esperado, diferencia, flagged, closed_at } = payload;

  db.prepare(`
    UPDATE turnos SET
      estado = ?,
      monto_esperado = ?,
      monto_contado = ?,
      diferencia = ?,
      closed_at = ?
    WHERE id = ?
  `).run(flagged ? 'CON_DESCUADRE' : 'CERRADO', monto_esperado, monto_contado, diferencia, closed_at, id);

  db.prepare(`
    INSERT INTO movimientos_caja (id, turno_id, tipo, monto)
    VALUES (?, ?, 'CIERRE', ?)
  `).run(uuidv4(), id, monto_contado);
}

async function crearMovimientoStockServer(payload: any): Promise<void> {
  const { id, producto_id, sucursal_id, tipo, cantidad, motivo, referencia_id, usuario_id, created_at } = payload;

  const existe = db.prepare('SELECT id FROM movimientos_stock WHERE id = ?').get(id);
  if (existe) return;

  db.prepare(`
    INSERT INTO movimientos_stock (id, producto_id, sucursal_id, tipo, cantidad, motivo, referencia_id, usuario_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, producto_id, sucursal_id, tipo, cantidad, motivo ?? null, referencia_id ?? null, usuario_id ?? null, created_at);
}

async function crearMovimientoCajaServer(payload: any): Promise<void> {
  const { id, turno_id, tipo, monto, motivo, autorizado_por, referencia_id, created_at } = payload;

  const existe = db.prepare('SELECT id FROM movimientos_caja WHERE id = ?').get(id);
  if (existe) return;

  db.prepare(`
    INSERT INTO movimientos_caja (id, turno_id, tipo, monto, motivo, autorizado_por, referencia_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, turno_id, tipo, monto, motivo ?? null, autorizado_por ?? null, referencia_id ?? null, created_at);
}

async function crearAuditoriaServer(payload: any): Promise<void> {
  const { id, usuario_id, accion, entidad, entidad_id, metadatos, ip, user_agent, created_at } = payload;

  const existe = db.prepare('SELECT id FROM auditoria WHERE id = ?').get(id);
  if (existe) return;

  db.prepare(`
    INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, usuario_id, accion, entidad ?? null, entidad_id ?? null, metadatos ?? null, ip ?? null, user_agent ?? null, created_at);
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

    const sinceDate = since ? new Date(since as string) : new Date(0);

    // Productos actualizados
    const productos = db.prepare(`
      SELECT * FROM productos WHERE sucursal_id = (SELECT sucursal_id FROM cajas WHERE id = ?) AND updated_at > ?
    `).all(caja_id, sinceDate.toISOString());

    // Stock
    const stock = db.prepare(`
      SELECT ss.*, p.nombre, p.sku, p.barcode
      FROM stock_sucursal ss
      JOIN productos p ON p.id = ss.producto_id
      WHERE ss.sucursal_id = (SELECT sucursal_id FROM cajas WHERE id = ?)
    `).all(caja_id);

    // Lotes
    const lotes = db.prepare(`
      SELECT * FROM lotes WHERE sucursal_id = (SELECT sucursal_id FROM cajas WHERE id = ?) AND cantidad > 0
    `).all(caja_id);

    // Usuarios
    const usuarios = db.prepare(`
      SELECT id, nombre, email, role FROM usuarios WHERE sucursal_id = (SELECT sucursal_id FROM cajas WHERE id = ?) AND activa = 1
    `).all(caja_id);

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
    const { caja_id } = req.query;
    if (!caja_id) {
      res.status(400).json({ error: 'caja_id requerido' });
      return;
    }

    const caja = db.prepare('SELECT id, nombre, estado, last_sync FROM cajas WHERE id = ?').get(caja_id);
    if (!caja) {
      res.status(404).json({ error: 'Caja no encontrada' });
      return;
    }

    const lastSync = db.prepare('SELECT * FROM sync_log WHERE caja_id = ? ORDER BY created_at DESC LIMIT 1').get(caja_id);
    const pendingOps = db.prepare('SELECT COUNT(*) as count FROM outbox WHERE caja_id = ? AND status = \'pending\'').get(caja_id) as { count: number };

    res.json({
      caja: { ...caja, last_sync: caja.last_sync },
      last_sync_log: lastSync,
      pending_operations: pendingOps.count,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo estado sync' });
  }
});

export default router;