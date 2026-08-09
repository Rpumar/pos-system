import type Database from 'better-sqlite3';
import { User } from '../../../domain/entities/User';
import { Shift } from '../../../domain/entities/Shift';
import { CashMovement } from '../../../domain/entities/CashMovement';
import { IUserRepository, IShiftRepository, IAuditLogRepository, AuditLogData, SalesByHour, SalesByMethod, SalesByCashier, ShiftSummary } from '../../../application/ports/IAuthRepositories';

// ── SqliteUserRepository ──────────────────────────────────────────────────────

interface UserRow { id: string; name: string; pin_hash: string; role: string; active: number; }

export class SqliteUserRepository implements IUserRepository {
  constructor(private readonly db: Database.Database) {}

  async findById(id: string): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!row) return null;
    return new User(row.id, row.name, row.pin_hash, row.role as User['role'], row.active === 1);
  }

  async findAll(): Promise<User[]> {
    const rows = this.db.prepare('SELECT * FROM users WHERE active = 1').all() as UserRow[];
    return rows.map((r) => new User(r.id, r.name, r.pin_hash, r.role as User['role'], r.active === 1));
  }
}

// ── SqliteShiftRepository ─────────────────────────────────────────────────────

interface ShiftRow {
  id: string; cashier_id: string; register_id: string;
  opening_amount: number; expected_cash: number | null;
  counted_cash: number | null; difference: number | null;
  status: string; opened_at: string; closed_at: string | null;
}

function shiftToDomain(r: ShiftRow): Shift {
  return new Shift(
    r.id, r.cashier_id, r.register_id, r.opening_amount,
    r.status as Shift['status'],
    new Date(r.opened_at),
    r.expected_cash ?? undefined,
    r.counted_cash ?? undefined,
    r.difference ?? undefined,
    r.closed_at ? new Date(r.closed_at) : undefined
  );
}

function shiftSummaryToDomain(r: any): ShiftSummary {
  return {
    id: r.id,
    cashierId: r.cashier_id,
    cashierName: r.cashier_name,
    registerId: r.register_id,
    openingAmount: r.opening_amount,
    expectedCash: r.expected_cash,
    countedCash: r.counted_cash,
    difference: r.difference,
    status: r.status,
    openedAt: new Date(r.opened_at),
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    totalSales: r.total_sales,
    totalCashSales: r.total_cash_sales,
    totalCardSales: r.total_card_sales,
    saleCount: r.sale_count,
  };
}

export class SqliteShiftRepository implements IShiftRepository {
  constructor(private readonly db: Database.Database) {}

  async create(data: { cashierId: string; registerId: string; openingAmount: number }): Promise<Shift> {
    const result = this.db
      .prepare('INSERT INTO shifts (cashier_id, register_id, opening_amount) VALUES (?, ?, ?)')
      .run(data.cashierId, data.registerId, data.openingAmount);
    const row = this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(result.lastInsertRowid) as ShiftRow;
    return shiftToDomain(row);
  }

  async findById(id: string): Promise<Shift | null> {
    const row = this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id) as ShiftRow | undefined;
    return row ? shiftToDomain(row) : null;
  }

  async findOpenByRegister(registerId: string): Promise<Shift | null> {
    const row = this.db
      .prepare("SELECT * FROM shifts WHERE register_id = ? AND status = 'OPEN'")
      .get(registerId) as ShiftRow | undefined;
    return row ? shiftToDomain(row) : null;
  }

  async close(id: string, data: { expectedCash: number; countedCash: number; difference: number }): Promise<void> {
    this.db
      .prepare(`UPDATE shifts SET status = 'CLOSED', expected_cash = ?, counted_cash = ?,
                difference = ?, closed_at = datetime('now') WHERE id = ?`)
      .run(data.expectedCash, data.countedCash, data.difference, id);
  }

  async getCashMovements(shiftId: string): Promise<CashMovement[]> {
    const rows = this.db.prepare('SELECT * FROM cash_movements WHERE shift_id = ?').all(shiftId) as Array<{
      id: string; shift_id: string; type: string; amount: number;
      reason: string | null; authorized_by: string | null; reference_id: string | null; created_at: string;
    }>;
    return rows.map((r) => new CashMovement(
      r.id, r.shift_id, r.type as CashMovement['type'], r.amount,
      r.reason ?? undefined, r.authorized_by ?? undefined, r.reference_id ?? undefined, new Date(r.created_at)
    ));
  }

  async addCashMovement(
    shiftId: string,
    data: { type: 'WITHDRAWAL' | 'DEPOSIT'; amount: number; reason?: string; authorizedBy?: string }
  ): Promise<void> {
    this.db
      .prepare(`INSERT INTO cash_movements (id, shift_id, type, amount, reason, authorized_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        crypto.randomUUID(),
        shiftId,
        data.type,
        data.amount,
        data.reason ?? null,
        data.authorizedBy ?? null,
        new Date().toISOString()
      );
  }

  async getCardSalesTotal(shiftId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE shift_id = ? AND payment_method = 'CARD' AND status = 'PAID'")
      .get(shiftId) as { total: number };
    return row.total;
  }

  // ── Report queries ──────────────────────────────────────────────────────────

  async getSalesByHour(shiftId: string): Promise<SalesByHour[]> {
    const rows = this.db.prepare(`
      SELECT
        CAST(strftime('%H', created_at) AS INTEGER) as hour,
        COUNT(*) as count,
        COALESCE(SUM(total), 0) as total,
        COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total ELSE 0 END), 0) as cashTotal,
        COALESCE(SUM(CASE WHEN payment_method = 'CARD' THEN total ELSE 0 END), 0) as cardTotal
      FROM sales
      WHERE shift_id = ? AND status = 'PAID'
      GROUP BY hour
      ORDER BY hour
    `).all(shiftId) as Array<{ hour: number; count: number; total: number; cashTotal: number; cardTotal: number }>;
    return rows;
  }

  async getSalesByMethod(shiftId: string): Promise<SalesByMethod[]> {
    const rows = this.db.prepare(`
      SELECT
        payment_method as method,
        COUNT(*) as count,
        COALESCE(SUM(total), 0) as total
      FROM sales
      WHERE shift_id = ? AND status = 'PAID'
      GROUP BY payment_method
    `).all(shiftId) as Array<{ method: 'CASH' | 'CARD'; count: number; total: number }>;
    return rows;
  }

  async getSalesByCashier(shiftId: string): Promise<SalesByCashier[]> {
    const rows = this.db.prepare(`
      SELECT
        s.cashier_id as cashierId,
        u.name as cashierName,
        COUNT(*) as count,
        COALESCE(SUM(s.total), 0) as total,
        COALESCE(SUM(CASE WHEN s.payment_method = 'CASH' THEN s.total ELSE 0 END), 0) as cashTotal,
        COALESCE(SUM(CASE WHEN s.payment_method = 'CARD' THEN s.total ELSE 0 END), 0) as cardTotal
      FROM sales s
      JOIN users u ON u.id = s.cashier_id
      WHERE s.shift_id = ? AND s.status = 'PAID'
      GROUP BY s.cashier_id, u.name
      ORDER BY total DESC
    `).all(shiftId) as Array<{ cashierId: string; cashierName: string; count: number; total: number; cashTotal: number; cardTotal: number }>;
    return rows;
  }

  async getShiftHistory(registerId?: string, limit = 50): Promise<ShiftSummary[]> {
    let sql = `
      SELECT
        sh.id, sh.cashier_id, u.name as cashier_name, sh.register_id,
        sh.opening_amount, sh.expected_cash, sh.counted_cash, sh.difference,
        sh.status, sh.opened_at, sh.closed_at,
        COALESCE(sales_agg.total_sales, 0) as total_sales,
        COALESCE(sales_agg.total_cash_sales, 0) as total_cash_sales,
        COALESCE(sales_agg.total_card_sales, 0) as total_card_sales,
        COALESCE(sales_agg.sale_count, 0) as sale_count
      FROM shifts sh
      JOIN users u ON u.id = sh.cashier_id
      LEFT JOIN (
        SELECT
          shift_id,
          COALESCE(SUM(total), 0) as total_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total ELSE 0 END), 0) as total_cash_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'CARD' THEN total ELSE 0 END), 0) as total_card_sales,
          COUNT(*) as sale_count
        FROM sales
        WHERE status = 'PAID'
        GROUP BY shift_id
      ) sales_agg ON sales_agg.shift_id = sh.id
    `;
    const params: any[] = [];
    if (registerId) {
      sql += ` WHERE sh.register_id = ?`;
      params.push(registerId);
    }
    sql += ` ORDER BY sh.opened_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(shiftSummaryToDomain);
  }

  async getShiftDetail(shiftId: string): Promise<ShiftSummary | null> {
    const row = this.db.prepare(`
      SELECT
        sh.id, sh.cashier_id, u.name as cashier_name, sh.register_id,
        sh.opening_amount, sh.expected_cash, sh.counted_cash, sh.difference,
        sh.status, sh.opened_at, sh.closed_at,
        COALESCE(sales_agg.total_sales, 0) as total_sales,
        COALESCE(sales_agg.total_cash_sales, 0) as total_cash_sales,
        COALESCE(sales_agg.total_card_sales, 0) as total_card_sales,
        COALESCE(sales_agg.sale_count, 0) as sale_count
      FROM shifts sh
      JOIN users u ON u.id = sh.cashier_id
      LEFT JOIN (
        SELECT
          shift_id,
          COALESCE(SUM(total), 0) as total_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total ELSE 0 END), 0) as total_cash_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'CARD' THEN total ELSE 0 END), 0) as total_card_sales,
          COUNT(*) as sale_count
        FROM sales
        WHERE status = 'PAID'
        GROUP BY shift_id
      ) sales_agg ON sales_agg.shift_id = sh.id
      WHERE sh.id = ?
    `).get(shiftId) as any | undefined;
    return row ? shiftSummaryToDomain(row) : null;
  }

  async getTopProducts(shiftId: string, limit = 10): Promise<Array<{ productId: string; sku: string; name: string; quantity: number; total: number }>> {
    const rows = this.db.prepare(`
      SELECT
        p.id as productId,
        p.sku,
        p.name,
        COALESCE(SUM(sd.quantity), 0) as quantity,
        COALESCE(SUM(sd.subtotal), 0) as total
      FROM sale_details sd
      JOIN sales s ON s.id = sd.sale_id
      JOIN products p ON p.id = sd.product_id
      WHERE s.shift_id = ? AND s.status = 'PAID'
      GROUP BY p.id, p.sku, p.name
      ORDER BY quantity DESC
      LIMIT ?
    `).all(shiftId, limit) as Array<{ productId: string; sku: string; name: string; quantity: number; total: number }>;
    return rows;
  }
}

// ── SqliteAuditLogRepository ──────────────────────────────────────────────────

export class SqliteAuditLogRepository implements IAuditLogRepository {
  constructor(private readonly db: Database.Database) {}

  async record(entry: AuditLogData): Promise<void> {
    this.db
      .prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(
        entry.userId, entry.action,
        entry.entity ?? null, entry.entityId ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null
      );
  }
}
