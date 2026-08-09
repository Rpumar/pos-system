import { Router, Request, Response } from 'express';
import { getDB } from '../db/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
const db = getDB();

// GET /api/dashboard/resumen - Resumen general
router.get('/resumen', authMiddleware, requireRole('ADMIN', 'MANAGER', 'SUPERVISOR'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const sucursalId = user.sucursalId;

    const hoy = new Date().toISOString().split('T')[0];

    // Ventas hoy
    const ventasHoy = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM ventas
      WHERE sucursal_id = ? AND date(created_at) = ? AND estado = 'PAGADA'
    `).get(sucursalId, hoy) as { count: number; total: number };

    // Ventas mes
    const primerDiaMes = new Date().toISOString().substring(0, 8) + '01';
    const ventasMes = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM ventas
      WHERE sucursal_id = ? AND date(created_at) >= ? AND estado = 'PAGADA'
    `).get(sucursalId, primerDiaMes) as { count: number; total: number };

    // Turnos abiertos
    const turnosAbiertos = db.prepare(`
      SELECT COUNT(*) as count FROM turnos WHERE sucursal_id = ? AND estado = 'ABIERTO'
    `).get(sucursalId) as { count: number };

    // Cajas activas
    const cajasActivas = db.prepare(`
      SELECT COUNT(*) as count FROM cajas WHERE sucursal_id = ? AND estado = 'ACTIVE'
    `).get(sucursalId) as { count: number };

    // Stock bajo
    const stockBajo = db.prepare(`
      SELECT COUNT(*) as count
      FROM stock_sucursal ss
      JOIN productos p ON p.id = ss.producto_id
      WHERE ss.sucursal_id = ? AND p.activo = 1 AND ss.cantidad <= ss.minimo AND ss.minimo > 0
    `).get(sucursalId) as { count: number };

    // Productos por vencer
    const porVencer = db.prepare(`
      SELECT COUNT(*) as count
      FROM lotes l
      WHERE l.sucursal_id = ? AND l.cantidad > 0 AND l.fecha_vencimiento <= date('now', '+7 days')
    `).get(sucursalId) as { count: number };

    // Top productos hoy
    const topProductos = db.prepare(`
      SELECT p.nombre, p.sku, SUM(vd.cantidad) as cantidad, SUM(vd.subtotal) as total
      FROM venta_detalles vd
      JOIN ventas v ON v.id = vd.venta_id
      JOIN productos p ON p.id = vd.producto_id
      WHERE v.sucursal_id = ? AND date(v.created_at) = ? AND v.estado = 'PAGADA'
      GROUP BY vd.producto_id
      ORDER BY cantidad DESC
      LIMIT 5
    `).all(sucursalId, hoy);

    // Ventas por hora hoy
    const ventasPorHora = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) as hora, COUNT(*) as count, SUM(total) as total
      FROM ventas
      WHERE sucursal_id = ? AND date(created_at) = ? AND estado = 'PAGADA'
      GROUP BY hora
      ORDER BY hora
    `).all(sucursalId, hoy);

    // Métodos de pago hoy
    const metodosPago = db.prepare(`
      SELECT metodo_pago, COUNT(*) as count, SUM(total) as total
      FROM ventas
      WHERE sucursal_id = ? AND date(created_at) = ? AND estado = 'PAGADA'
      GROUP BY metodo_pago
    `).all(sucursalId, hoy);

    res.json({
      fecha: hoy,
      ventas_hoy: ventasHoy,
      ventas_mes: ventasMes,
      turnos_abiertos: turnosAbiertos.count,
      cajas_activas: cajasActivas.count,
      stock_bajo: stockBajo.count,
      productos_por_vencer: porVencer.count,
      top_productos: topProductos,
      ventas_por_hora: ventasPorHora,
      metodos_pago: metodosPago,
    });
  } catch (error) {
    console.error('[Dashboard] Error:', error);
    res.status(500).json({ error: 'Error obteniendo resumen' });
  }
});

// GET /api/dashboard/ventas - Ventas con filtros
router.get('/ventas', authMiddleware, requireRole('ADMIN', 'MANAGER', 'SUPERVISOR'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { sucursal_id, desde, hasta, group_by = 'day', limit = '100' } = req.query;

    const sId = sucursal_id || user.sucursalId;

    let sql = '';
    if (group_by === 'hour') {
      sql = `
        SELECT strftime('%Y-%m-%d %H:00', created_at) as periodo, COUNT(*) as count, SUM(total) as total
        FROM ventas
        WHERE sucursal_id = ? AND date(created_at) BETWEEN ? AND ? AND estado = 'PAGADA'
        GROUP BY periodo
        ORDER BY periodo
      `;
    } else if (group_by === 'day') {
      sql = `
        SELECT date(created_at) as periodo, COUNT(*) as count, SUM(total) as total
        FROM ventas
        WHERE sucursal_id = ? AND date(created_at) BETWEEN ? AND ? AND estado = 'PAGADA'
        GROUP BY periodo
        ORDER BY periodo
      `;
    } else {
      sql = `
        SELECT strftime('%Y-%m', created_at) as periodo, COUNT(*) as count, SUM(total) as total
        FROM ventas
        WHERE sucursal_id = ? AND date(created_at) BETWEEN ? AND ? AND estado = 'PAGADA'
        GROUP BY periodo
        ORDER BY periodo
      `;
    }

    const data = db.prepare(sql).all(sId, desde || '2024-01-01', hasta || new Date().toISOString().split('T')[0]);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo ventas' });
  }
});

// GET /api/dashboard/cajas - Estado de cajas
router.get('/cajas', authMiddleware, requireRole('ADMIN', 'MANAGER', 'SUPERVISOR'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const sucursalId = req.query.sucursal_id as string || user.sucursalId;

    const cajas = db.prepare(`
      SELECT c.*, t.id as turno_id, t.estado as turno_estado, t.opened_at, u.nombre as usuario_nombre
      FROM cajas c
      LEFT JOIN turnos t ON t.caja_id = c.id AND t.estado = 'ABIERTO'
      LEFT JOIN usuarios u ON u.id = t.usuario_id
      WHERE c.sucursal_id = ?
      ORDER BY c.nombre
    `).all(sucursalId);

    interface SyncLogEntry {
  caja_id: string;
  last_sync: string;
  estado: string;
}

    // Último sync de cada caja
    const syncLogs = db.prepare(`
      SELECT caja_id, MAX(created_at) as last_sync, estado
      FROM sync_log
      WHERE caja_id IN (SELECT id FROM cajas WHERE sucursal_id = ?)
      GROUP BY caja_id
    `).all(sucursalId) as SyncLogEntry[];

    const syncMap = new Map<string, SyncLogEntry>(syncLogs.map((s: SyncLogEntry) => [s.caja_id, s]));

    const resultado = cajas.map((c: any) => ({
      ...c,
      last_sync: syncMap.get(c.id)?.last_sync,
      sync_estado: syncMap.get(c.id)?.estado,
    }));

    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo cajas' });
  }
});

// GET /api/dashboard/stock - Stock crítico
router.get('/stock', authMiddleware, requireRole('ADMIN', 'MANAGER', 'SUPERVISOR'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const sucursalId = req.query.sucursal_id as string || user.sucursalId;

    const stockBajo = db.prepare(`
      SELECT p.id, p.sku, p.barcode, p.nombre, p.precio, ss.cantidad, ss.minimo, ss.maximo, ss.ubicacion
      FROM stock_sucursal ss
      JOIN productos p ON p.id = ss.producto_id
      WHERE ss.sucursal_id = ? AND p.activo = 1 AND ss.cantidad <= ss.minimo AND ss.minimo > 0
      ORDER BY ss.cantidad ASC
    `).all(sucursalId);

    const sinStock = db.prepare(`
      SELECT p.id, p.sku, p.barcode, p.nombre, p.precio
      FROM stock_sucursal ss
      JOIN productos p ON p.id = ss.producto_id
      WHERE ss.sucursal_id = ? AND p.activo = 1 AND ss.cantidad = 0
      ORDER BY p.nombre
    `).all(sucursalId);

    res.json({ stock_bajo: stockBajo, sin_stock: sinStock });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo stock' });
  }
});

// GET /api/dashboard/vencimientos - Próximos vencimientos
router.get('/vencimientos', authMiddleware, requireRole('ADMIN', 'MANAGER', 'SUPERVISOR'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const sucursalId = req.query.sucursal_id as string || user.sucursalId;
    const dias = parseInt(req.query.dias as string) || 30;

    const vencimientos = db.prepare(`
      SELECT l.id, l.codigo_lote, l.cantidad, l.fecha_vencimiento,
             p.id as producto_id, p.sku, p.barcode, p.nombre,
             CAST(julianday(l.fecha_vencimiento) - julianday('now') AS INTEGER) as dias_restantes
      FROM lotes l
      JOIN productos p ON p.id = l.producto_id
      WHERE l.sucursal_id = ? AND l.cantidad > 0 AND l.fecha_vencimiento <= date('now', '+' || ? || ' days')
      ORDER BY l.fecha_vencimiento ASC
    `).all(sucursalId, dias);

    res.json(vencimientos);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo vencimientos' });
  }
});

export default router;