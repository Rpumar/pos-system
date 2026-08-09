import type Database from 'better-sqlite3';
import { IBatchRepository, ExpirationAlert, classifyUrgency } from '../../../application/ports/IBatchRepository';

interface ExpirationRow {
  batchId: string;
  productId: string;
  productName: string;
  sku: string;
  batchCode: string;
  quantity: number;
  expirationDate: string;
  daysUntilExpiration: number;
}

export class SqliteBatchRepository implements IBatchRepository {
  constructor(private readonly db: Database.Database) {}

  async findExpiringWithin(days: number): Promise<ExpirationAlert[]> {
    // El predicado golpea directamente idx_batches_expiration (índice
    // parcial WHERE quantity > 0), sin escanear lotes ya agotados.
    const rows = this.db
      .prepare(
        `SELECT
           b.id as batchId, b.product_id as productId, p.name as productName,
           p.sku, b.batch_code as batchCode, b.quantity,
           b.expiration_date as expirationDate,
           CAST(julianday(b.expiration_date) - julianday('now') AS INTEGER) as daysUntilExpiration
         FROM batches b
         JOIN products p ON p.id = b.product_id
         WHERE b.quantity > 0
           AND b.expiration_date <= date('now', '+' || ? || ' days')
         ORDER BY b.expiration_date ASC`
      )
      .all(days) as ExpirationRow[];

    return rows.map((r) => ({
      batchId: r.batchId,
      productId: r.productId,
      productName: r.productName,
      sku: r.sku,
      batchCode: r.batchCode,
      quantity: r.quantity,
      expirationDate: new Date(r.expirationDate),
      daysUntilExpiration: r.daysUntilExpiration,
      urgency: classifyUrgency(r.daysUntilExpiration),
    }));
  }
}
