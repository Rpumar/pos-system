import { Router, Request, Response } from 'express';
import { getDB } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();
const db = getDB();

class ClientError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ClientError';
  }
}

const VentaSchema = z.object({
  turno_id: z.string().uuid(),
  caja_id: z.string().uuid(),
  sucursal_id: z.string().uuid(),
  usuario_id: z.string().uuid(),
  metodo_pago: z.enum(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'MIXTO']),
  codigo_autorizacion: z.string().optional(),
  detalles: z.array(z.object({
    producto_id: z.string().uuid(),
    cantidad: z.number().int().min(1),
    precio_unitario: z.number().min(0),
    impuesto: z.number().min(0).max(1).default(0.21),
    lote_id: z.string().uuid().optional(),
  })).min(1),
});

// POST /api/ventas - Crear venta (sync desde POS)
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const data = VentaSchema.parse(req.body);

    // Verificar turno
    const turno = db.prepare('SELECT * FROM turnos WHERE id = ? AND estado = \'ABIERTO\'').get(data.turno_id);
    if (!turno) {
      res.status(400).json({ error: 'Turno no encontrado o no está abierto' });
      return;
    }

    // ── El servidor es la fuente de verdad de PRECIOS e IMPUESTO ──────────────
    // No se confían los importes que envía el cliente (precio_unitario/impuesto):
    // se recalculan contra el catálogo maestro. Un POS manipulado no puede
    // vender a un precio arbitrario.
    const masterRows = data.detalles.map((det) => {
      const prod = db.prepare('SELECT id, precio, impuesto, nombre, activo FROM productos WHERE id = ?').get(det.producto_id) as
        { id: string; precio: number; impuesto: number; nombre: string; activo: number } | undefined;
      if (!prod || prod.activo !== 1) throw new ClientError(`Producto no encontrado o inactivo (${det.producto_id})`, 404);
      return { ...det, prod };
    });

    // Verificar disponibilidad de stock ANTES de tocar la base
    const stockByProduct = new Map<string, number>();
    for (const det of data.detalles) {
      stockByProduct.set(det.producto_id, (stockByProduct.get(det.producto_id) ?? 0) + det.cantidad);
    }
    for (const [productoId, qty] of stockByProduct) {
      const stock = db.prepare('SELECT cantidad FROM stock_sucursal WHERE producto_id = ? AND sucursal_id = ?')
        .get(productoId, data.sucursal_id) as { cantidad: number } | undefined;
      if (!stock || stock.cantidad < qty) {
        res.status(400).json({ error: `Stock insuficiente para el producto ${productoId}` });
        return;
      }
    }

    // Calcular totales con precio/imposto del maestro
    let subtotal = 0;
    let impuestos = 0;
    for (const m of masterRows) {
      const line = m.prod.precio * m.cantidad;
      subtotal += line;
      impuestos += line * m.prod.impuesto;
    }
    const total = subtotal + impuestos;

    const id = uuidv4();
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      // Insertar venta
      db.prepare(`
        INSERT INTO ventas (id, turno_id, caja_id, sucursal_id, usuario_id, metodo_pago, codigo_autorizacion, subtotal, impuestos, total, estado, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAGADA', ?)
      `).run(id, data.turno_id, data.caja_id, data.sucursal_id, data.usuario_id, data.metodo_pago, data.codigo_autorizacion ?? null, subtotal, impuestos, total, now);

      // Detalles, precio del maestro y stock con guarda atómica
      for (const m of masterRows) {
        const detId = uuidv4();
        const detSubtotal = m.prod.precio * m.cantidad;
        db.prepare(`
          INSERT INTO venta_detalles (id, venta_id, producto_id, cantidad, precio_unitario, impuesto, subtotal, lote_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(detId, id, m.producto_id, m.cantidad, m.prod.precio, m.prod.impuesto, detSubtotal, m.lote_id ?? null);

        // Descuento condicional: evita stock negativo en condiciones de carrera
        const stockRes = db.prepare(`
          UPDATE stock_sucursal SET cantidad = cantidad - ?
          WHERE producto_id = ? AND sucursal_id = ? AND cantidad >= ?
        `).run(m.cantidad, m.producto_id, data.sucursal_id, m.cantidad);
        if (stockRes.changes === 0) {
          throw new ClientError(`Stock insuficiente para el producto ${m.producto_id}`, 400);
        }

        // Movimiento stock
        db.prepare(`
          INSERT INTO movimientos_stock (id, producto_id, sucursal_id, tipo, cantidad, motivo, referencia_id, usuario_id)
          VALUES (?, ?, ?, 'SALIDA', ?, 'VENTA', ?, ?)
        `).run(uuidv4(), m.producto_id, data.sucursal_id, m.cantidad, id, user.userId);
      }

      // Movimiento caja
      const montoEfectivo = data.metodo_pago === 'EFECTIVO' ? total : (data.metodo_pago === 'MIXTO' ? total / 2 : 0);
      if (montoEfectivo > 0) {
        db.prepare(`
          INSERT INTO movimientos_caja (id, turno_id, tipo, monto, referencia_id)
          VALUES (?, ?, 'VENTA_EFECTIVO', ?, ?)
        `).run(uuidv4(), data.turno_id, montoEfectivo, id);
      }
    });

    tx();

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'CREATE', 'venta', ?, ?)
    `).run(uuidv4(), user.userId, id, JSON.stringify({ total, metodo_pago: data.metodo_pago }));

    res.status(201).json({ id, total, synced_at: now });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Datos inválidos', details: error.errors });
      return;
    }
    if (error instanceof ClientError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('[Ventas] Error:', error);
    res.status(500).json({ error: 'Error creando venta' });
  }
});

// GET /api/ventas - Listar ventas
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { sucursal_id, caja_id, turno_id, estado, desde, hasta, limit = '50', offset = '0' } = req.query;

    let sql = 'SELECT * FROM ventas WHERE 1=1';
    const params: any[] = [];

    if (sucursal_id) { sql += ' AND sucursal_id = ?'; params.push(sucursal_id); }
    else if (user.role !== 'ADMIN') { sql += ' AND sucursal_id = ?'; params.push(user.sucursalId); }

    if (caja_id) { sql += ' AND caja_id = ?'; params.push(caja_id); }
    if (turno_id) { sql += ' AND turno_id = ?'; params.push(turno_id); }
    if (estado) { sql += ' AND estado = ?'; params.push(estado); }
    if (desde) { sql += ' AND created_at >= ?'; params.push(desde); }
    if (hasta) { sql += ' AND created_at <= ?'; params.push(hasta); }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));

    const ventas = db.prepare(sql).all(...params);
    res.json(ventas);
  } catch (error) {
    res.status(500).json({ error: 'Error listando ventas' });
  }
});

// GET /api/ventas/:id - Obtener venta con detalles
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const venta = db.prepare('SELECT * FROM ventas WHERE id = ?').get(req.params.id);
    if (!venta) {
      res.status(404).json({ error: 'Venta no encontrada' });
      return;
    }

    const detalles = db.prepare(`
      SELECT vd.*, p.nombre, p.sku, p.barcode
      FROM venta_detalles vd
      JOIN productos p ON p.id = vd.producto_id
      WHERE vd.venta_id = ?
    `).all(req.params.id);

    res.json({ ...venta, detalles });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo venta' });
  }
});

// POST /api/ventas/:id/anular - Anular venta
router.post('/:id/anular', authMiddleware, requireRole('SUPERVISOR', 'ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { motivo } = req.body;

    const venta = db.prepare('SELECT * FROM ventas WHERE id = ?').get(req.params.id);
    if (!venta) {
      res.status(404).json({ error: 'Venta no encontrada' });
      return;
    }
    if (venta.estado !== 'PAGADA') {
      res.status(400).json({ error: 'Solo se pueden anular ventas pagadas' });
      return;
    }

    const now = new Date().toISOString();
    const detalles = db.prepare('SELECT * FROM venta_detalles WHERE venta_id = ?').all(req.params.id);

    const tx = db.transaction(() => {
      // Marcar venta como anulada ATÓMICAMENTE: si dos peticiones llegan a la vez,
      // solo la primera cambia el estado; la segunda impacta 0 filas y revierte.
      const updated = db.prepare('UPDATE ventas SET estado = \'ANULADA\' WHERE id = ? AND estado = \'PAGADA\'').run(req.params.id);
      if (updated.changes === 0) {
        throw new ClientError('La venta ya fue anulada', 400);
      }

      // Devolver stock
      for (const det of detalles) {
        db.prepare(`
          UPDATE stock_sucursal SET cantidad = cantidad + ? WHERE producto_id = ? AND sucursal_id = ?
        `).run(det.cantidad, det.producto_id, venta.sucursal_id);

        db.prepare(`
          INSERT INTO movimientos_stock (id, producto_id, sucursal_id, tipo, cantidad, motivo, referencia_id, usuario_id)
          VALUES (?, ?, ?, 'DEVOLUCION', ?, 'ANULACION_VENTA', ?, ?)
        `).run(uuidv4(), det.producto_id, venta.sucursal_id, det.cantidad, req.params.id, user.userId);
      }

      // Movimiento caja reverso
      if (venta.metodo_pago === 'EFECTIVO' || venta.metodo_pago === 'MIXTO') {
        const montoEfectivo = venta.metodo_pago === 'EFECTIVO' ? venta.total : venta.total / 2;
        db.prepare(`
          INSERT INTO movimientos_caja (id, turno_id, tipo, monto, motivo, referencia_id)
          VALUES (?, ?, 'DEVOLUCION', ?, 'Anulación venta', ?)
        `).run(uuidv4(), venta.turno_id, -montoEfectivo, req.params.id);
      }
    });

    tx();

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'ANULAR', 'venta', ?, ?)
    `).run(uuidv4(), user.userId, req.params.id, JSON.stringify({ motivo, total: venta.total }));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error anulando venta' });
  }
});

export default router;