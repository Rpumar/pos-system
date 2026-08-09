import type Database from 'better-sqlite3';
import { CartItem } from '../../../domain/entities/Cart';
import {
  ITransaction,
  SaleData,
  StockMovementData,
  CashMovementData,
  BatchConsumption,
} from '../../../application/ports/IUnitOfWork';
import { InsufficientBatchCoverageError } from '../../../application/errors/StockErrors';

export class SqliteTransaction implements ITransaction {
  constructor(private readonly db: Database.Database) {}

  findSaleById(saleId: string): import('../../../application/ports/IUnitOfWork').SaleRow | null {
    const sale = this.db.prepare(
      `SELECT id, shift_id as shiftId, payment_method as paymentMethod, total FROM sales WHERE id = ? AND status = 'PAID'`
    ).get(saleId) as { id: string; shiftId: string; paymentMethod: 'CASH' | 'CARD'; total: number } | undefined;
    if (!sale) return null;
    const details = this.db.prepare(`SELECT product_id as productId, quantity FROM sale_details WHERE sale_id = ?`).all(saleId) as Array<{ productId: string; quantity: number }>;
    return { id: sale.id, shiftId: sale.shiftId, paymentMethod: sale.paymentMethod, total: sale.total, details };
  }

  voidSale(saleId: string): void {
    this.db.prepare(`UPDATE sales SET status = 'VOIDED' WHERE id = ?`).run(saleId);
  }

  findOpenShift(shiftId: string): { id: string; status: string } | null {
    const row = this.db
      .prepare(`SELECT id, status FROM shifts WHERE id = ? AND status = 'OPEN'`)
      .get(shiftId) as { id: string; status: string } | undefined;
    return row ?? null;
  }

  decrementStock(productId: string, quantity: number): boolean {
    const result = this.db
      .prepare(`UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`)
      .run(quantity, productId, quantity);
    return result.changes === 1;
  }

  incrementStock(productId: string, quantity: number): void {
    this.db.prepare(`UPDATE products SET stock = stock + ? WHERE id = ?`).run(quantity, productId);
  }

  consumeBatchesFefo(productId: string, quantity: number): BatchConsumption[] {
    // Usa idx_batches_expiration: orden de vencimiento, solo lotes con stock real.
    const batches = this.db
      .prepare(
        `SELECT id, batch_code, quantity FROM batches
         WHERE product_id = ? AND quantity > 0
         ORDER BY expiration_date ASC`
      )
      .all(productId) as { id: string; batch_code: string; quantity: number }[];

    const consumptions: BatchConsumption[] = [];
    let remaining = quantity;

    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);

      const result = this.db
        .prepare(`UPDATE batches SET quantity = quantity - ? WHERE id = ? AND quantity >= ?`)
        .run(take, batch.id, take);

      if (result.changes === 1) {
        consumptions.push({ batchId: batch.id, batchCode: batch.batch_code, quantityTaken: take });
        remaining -= take;
      }
    }

    if (remaining > 0) {
      throw new InsufficientBatchCoverageError(productId, quantity, quantity - remaining);
    }

    return consumptions;
  }

  insertBatch(data: { productId: string; batchCode: string; quantity: number; expirationDate: Date }): string {
    const isoDate = data.expirationDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const result = this.db
      .prepare(`INSERT INTO batches (product_id, batch_code, quantity, expiration_date) VALUES (?, ?, ?, ?)`)
      .run(data.productId, data.batchCode, data.quantity, isoDate);
    return String(result.lastInsertRowid);
  }

  insertSale(data: SaleData): string {
    const result = this.db
      .prepare(
        `INSERT INTO sales (shift_id, cashier_id, total, payment_method, auth_code, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(data.shiftId, data.cashierId, data.total, data.method, data.authCode ?? null, data.status);
    return String(result.lastInsertRowid);
  }

  insertSaleDetails(saleId: string, items: CartItem[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO sale_details (sale_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`
    );
    for (const item of items) {
      stmt.run(saleId, item.productId, item.quantity, item.unitPrice, item.subtotal);
    }
  }

  insertStockMovement(m: StockMovementData): void {
    this.db
      .prepare(
        `INSERT INTO stock_movements (product_id, delta, reason, reference_id, batch_detail)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(m.productId, m.delta, m.reason, m.referenceId ?? null, m.batchDetail ? JSON.stringify(m.batchDetail) : null);
  }

  insertCashMovement(m: CashMovementData): void {
    this.db
      .prepare(`INSERT INTO cash_movements (shift_id, type, amount, reference_id) VALUES (?, ?, ?, ?)`)
      .run(m.shiftId, m.type, m.amount, m.referenceId ?? null);
  }
}
