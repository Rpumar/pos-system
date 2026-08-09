import { Router, Request, Response } from 'express';
import { getDB } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, requireRole, requireSucursal } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();
const db = getDB();

// Validación schemas
const ProductoSchema = z.object({
  sku: z.string().min(1),
  barcode: z.string().min(1),
  nombre: z.string().min(1),
  descripcion: z.string().optional(),
  precio: z.number().min(0),
  costo: z.number().min(0).optional(),
  impuesto: z.number().min(0).max(1).default(0.21),
  stock_central: z.number().int().min(0).default(0),
});

const ProductoUpdateSchema = ProductoSchema.partial();

const StockSucursalSchema = z.object({
  producto_id: z.string().uuid(),
  sucursal_id: z.string().uuid(),
  cantidad: z.number().int().min(0),
  minimo: z.number().int().min(0).default(0),
  maximo: z.number().int().min(0).default(0),
  ubicacion: z.string().optional(),
});

// GET /api/productos - Listar productos
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { sucursal_id, activo, search, limit = '50', offset = '0' } = req.query;

    let sql = `
      SELECT p.*, s.cantidad as stock_sucursal, s.minimo, s.maximo, s.ubicacion
      FROM productos p
      LEFT JOIN stock_sucursal s ON s.producto_id = p.id AND s.sucursal_id = ?
      WHERE 1=1
    `;
    const params: any[] = [user.sucursalId];

    if (activo !== undefined) {
      sql += ' AND p.activo = ?';
      params.push(activo === 'true' ? 1 : 0);
    }
    if (search) {
      sql += ' AND (p.nombre LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    sql += ' ORDER BY p.nombre LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));

    const productos = db.prepare(sql).all(...params);
    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: 'Error listando productos' });
  }
});

// GET /api/productos/stock/bajo - Stock bajo (antes de /:id para no ser capturado)
router.get('/stock/bajo', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const productos = db.prepare(`
      SELECT p.id, p.sku, p.barcode, p.nombre, p.precio, s.cantidad, s.minimo
      FROM productos p
      JOIN stock_sucursal s ON s.producto_id = p.id
      WHERE s.sucursal_id = ? AND p.activo = 1 AND s.cantidad <= s.minimo AND s.minimo > 0
      ORDER BY s.cantidad ASC
    `).all(user.sucursalId);

    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo stock bajo' });
  }
});

// GET /api/productos/vencimientos - Alertas de vencimiento (antes de /:id)
router.get('/vencimientos', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const dias = parseInt(req.query.dias as string) ?? 30;

    const alertas = db.prepare(`
      SELECT l.id, l.codigo_lote, l.cantidad, l.fecha_vencimiento,
             p.id as producto_id, p.sku, p.nombre,
             CAST(julianday(l.fecha_vencimiento) - julianday('now') AS INTEGER) as dias_para_vencer
      FROM lotes l
      JOIN productos p ON p.id = l.producto_id
      WHERE l.sucursal_id = ? AND l.cantidad > 0 AND l.fecha_vencimiento <= date('now', '+' || ? || ' days')
      ORDER BY l.fecha_vencimiento ASC
    `).all(user.sucursalId, dias);

    res.json(alertas);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo vencimientos' });
  }
});

// GET /api/productos/:id - Obtener producto
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const producto = db.prepare(`
      SELECT p.*, s.cantidad as stock_sucursal, s.minimo, s.maximo, s.ubicacion
      FROM productos p
      LEFT JOIN stock_sucursal s ON s.producto_id = p.id AND s.sucursal_id = ?
      WHERE p.id = ?
    `).get(user.sucursalId, req.params.id);

    if (!producto) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    // Lotes
    const lotes = db.prepare(`
      SELECT * FROM lotes WHERE producto_id = ? AND sucursal_id = ? AND cantidad > 0
      ORDER BY fecha_vencimiento ASC
    `).all(req.params.id, user.sucursalId);

    res.json({ ...producto, lotes });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo producto' });
  }
});

// POST /api/productos - Crear producto
router.post('/', authMiddleware, requireRole('ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const data = ProductoSchema.parse(req.body);

    // Verificar duplicados
    const existing = db.prepare('SELECT id FROM productos WHERE sku = ? OR barcode = ?').get(data.sku, data.barcode);
    if (existing) {
      res.status(400).json({ error: 'SKU o código de barras ya existe' });
      return;
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO productos (id, sku, barcode, nombre, descripcion, precio, costo, impuesto, stock_central, activo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, data.sku, data.barcode, data.nombre, data.descripcion ?? null, data.precio, data.costo ?? null, data.impuesto, data.stock_central, now, now);

    // Crear stock en sucursal
    db.prepare(`
      INSERT OR IGNORE INTO stock_sucursal (producto_id, sucursal_id, cantidad, minimo, maximo)
      VALUES (?, ?, 0, 0, 0)
    `).run(id, user.sucursalId);

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'CREATE', 'producto', ?, ?)
    `).run(uuidv4(), user.userId, id, JSON.stringify(data));

    res.status(201).json({ id, ...data });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Datos inválidos', details: error.errors });
      return;
    }
    res.status(500).json({ error: 'Error creando producto' });
  }
});

// PUT /api/productos/:id - Actualizar producto
router.put('/:id', authMiddleware, requireRole('ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const data = ProductoUpdateSchema.parse(req.body);

    const existing = db.prepare('SELECT * FROM productos WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    // Verificar duplicados si cambia sku/barcode
    if (data.sku || data.barcode) {
      const dup = db.prepare('SELECT id FROM productos WHERE (sku = ? OR barcode = ?) AND id != ?')
        .get(data.sku ?? existing.sku, data.barcode ?? existing.barcode, req.params.id);
      if (dup) {
        res.status(400).json({ error: 'SKU o código de barras ya existe' });
        return;
      }
    }

    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (fields.length === 0) {
      res.status(400).json({ error: 'Sin campos para actualizar' });
      return;
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(req.params.id);

    db.prepare(`UPDATE productos SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'UPDATE', 'producto', ?, ?)
    `).run(uuidv4(), user.userId, req.params.id, JSON.stringify(data));

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Datos inválidos', details: error.errors });
      return;
    }
    res.status(500).json({ error: 'Error actualizando producto' });
  }
});

// DELETE /api/productos/:id - Desactivar producto
router.delete('/:id', authMiddleware, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = db.prepare('UPDATE productos SET activo = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'DELETE', 'producto', ?, ?)
    `).run(uuidv4(), user.userId, req.params.id, JSON.stringify({ id: req.params.id }));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error desactivando producto' });
  }
});

// POST /api/productos/:id/stock - Actualizar stock en sucursal
router.post('/:id/stock', authMiddleware, requireRole('ADMIN', 'MANAGER', 'SUPERVISOR'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const data = StockSucursalSchema.parse(req.body);

    if (data.sucursal_id !== user.sucursalId && user.role !== 'ADMIN') {
      res.status(403).json({ error: 'No autorizado para esta sucursal' });
      return;
    }

    db.prepare(`
      INSERT INTO stock_sucursal (producto_id, sucursal_id, cantidad, minimo, maximo, ubicacion)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
        cantidad = excluded.cantidad,
        minimo = excluded.minimo,
        maximo = excluded.maximo,
        ubicacion = excluded.ubicacion
    `).run(data.producto_id, data.sucursal_id, data.cantidad, data.minimo, data.maximo, data.ubicacion ?? null);

    // Movimiento de stock
    db.prepare(`
      INSERT INTO movimientos_stock (id, producto_id, sucursal_id, tipo, cantidad, motivo, usuario_id)
      VALUES (?, ?, ?, 'AJUSTE', ?, 'Ajuste manual', ?)
    `).run(uuidv4(), data.producto_id, data.sucursal_id, data.cantidad, user.userId);

    // Auditoría
    db.prepare(`
      INSERT INTO auditoria (id, usuario_id, accion, entidad, entidad_id, metadatos)
      VALUES (?, ?, 'STOCK_UPDATE', 'producto', ?, ?)
    `).run(uuidv4(), user.userId, req.params.id, JSON.stringify(data));

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Datos inválidos', details: error.errors });
      return;
    }
    res.status(500).json({ error: 'Error actualizando stock' });
  }
});

export default router;