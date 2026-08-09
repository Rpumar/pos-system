import { CartItem } from '../../../domain/entities/Cart';
import { Sale } from '../../../domain/entities/Sale';
import {
  IUnitOfWork,
  ITransaction,
  SaleData,
  SaleRow,
  BatchConsumption,
  CashMovementData,
} from '../../../application/ports/IUnitOfWork';
import { NoActiveShiftError } from '../../../application/errors/StockErrors';
import { ApiClient } from '../../http/ApiClient';
import { ServerSessionContext } from './ServerSessionContext';

/**
 * Unit of Work remoto: acumula las operaciones de la transacción en memoria
 * (el contrato ITransaction es síncrono a propósito) y al terminar
 * `execute()` emite UNA sola petición POST /api/ventas que el servidor
 * procesa atómicamente. Si el servidor rechaza la venta, la transacción
 * completa falla y no se confirma nada.
 */
export class ServerUnitOfWork implements IUnitOfWork {
  private stock = new Map<string, number>();

  constructor(
    private readonly api: ApiClient,
    private readonly ctx: ServerSessionContext
  ) {}

  setStockSnapshot(productId: string, quantity: number): void {
    this.stock.set(productId, quantity);
  }

  async execute<T>(work: (tx: ITransaction) => T): Promise<T> {
    if (this.stock.size === 0) {
      await this.loadStockSnapshot();
    }
    const tx = new ServerTransaction(this.ctx, new Map(this.stock));
    let result = work(tx);

    if (tx.sale) {
      const serverSale = await this.pushSale(tx);
      this.stock = tx.stock;
      if (serverSale?.id && result instanceof Sale) {
        result = new Sale(
          serverSale.id,
          result.shiftId,
          result.cashierId,
          result.details,
          result.total,
          result.status,
          result.paymentMethod,
          result.authCode,
          result.createdAt
        ) as unknown as T;
      }
    }

    if (tx.voidSaleId) {
      await this.pushVoid(tx);
      this.stock = new Map();
    }

    if (tx.receivedBatch) {
      await this.pushBatchReceive(tx);
      this.stock = tx.stock;
    }

    return result;
  }

  private async loadStockSnapshot(): Promise<void> {
    const rows = (await this.api.get<unknown[]>(
      `/productos?activo=true&limit=1000`
    )) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const qty = Number(r['stock_sucursal'] ?? r['stock_central'] ?? 0);
      this.stock.set(String(r['id']), qty);
    }
  }

  private async pushSale(tx: ServerTransaction): Promise<{ id: string; total: number } | null> {
    const sale = tx.sale;
    if (!sale) return null;
    const reg = this.ctx.getShiftRegister(sale.shiftId);
    if (!reg) throw new NoActiveShiftError(sale.shiftId);
    if (!this.ctx.isShiftOpen(sale.shiftId)) throw new NoActiveShiftError(sale.shiftId);

    const body = {
      turno_id: sale.shiftId,
      caja_id: reg.cajaId,
      sucursal_id: reg.sucursalId,
      usuario_id: sale.cashierId,
      metodo_pago: sale.method === 'CASH' ? 'EFECTIVO' : 'TARJETA',
      codigo_autorizacion: sale.authCode ?? undefined,
      detalles: tx.items.map((i) => ({
        producto_id: i.productId,
        cantidad: i.quantity,
        precio_unitario: i.unitPrice,
        impuesto: 0,
      })),
    };

    return await this.api.post<{ id: string; total: number }>('/ventas', body);
  }

  private async pushVoid(tx: ServerTransaction): Promise<void> {
    const saleId = tx.voidSaleId;
    if (!saleId) return;
    await this.api.post(`/ventas/${encodeURIComponent(saleId)}/anular`, {
      motivo: tx.voidReason ?? 'Anulación desde POS',
    });
  }

  private async pushBatchReceive(tx: ServerTransaction): Promise<void> {
    const rec = tx.receivedBatch;
    if (!rec) return;
    const sucursalId = this.ctx.getSucursalId();
    if (!sucursalId) throw new Error('Sucursal no resuelta para recepción de stock');
    const cantidad = tx.stock.get(rec.productId) ?? rec.quantity;
    await this.api.post(`/productos/${encodeURIComponent(rec.productId)}/stock`, {
      producto_id: rec.productId,
      sucursal_id: sucursalId,
      cantidad,
      minimo: 0,
      maximo: 0,
    });
  }
}

class ServerTransaction implements ITransaction {
  sale: SaleData | null = null;
  items: CartItem[] = [];
  voidSaleId: string | null = null;
  voidReason: string | undefined;
  receivedBatch: { productId: string; quantity: number } | null = null;

  constructor(
    private readonly ctx: ServerSessionContext,
    readonly stock: Map<string, number>
  ) {}

  findOpenShift(shiftId: string): { id: string; status: string } | null {
    if (!this.ctx.isShiftOpen(shiftId)) return null;
    return { id: shiftId, status: 'OPEN' };
  }

  findSaleById(saleId: string): SaleRow | null {
    // En modo servidor la reversión de caja/stock la ejecuta el propio server
    // (POST /ventas/:id/anular, transacción atómica). No exponemos detalles
    // locales: total 0 evita registrar un REFUND duplicado aquí.
    return { id: saleId, shiftId: '', paymentMethod: 'CASH', total: 0, details: [] };
  }

  voidSale(saleId: string, reason?: string): void {
    this.voidSaleId = saleId;
    this.voidReason = reason;
  }

  decrementStock(productId: string, quantity: number): boolean {
    const current = this.stock.get(productId) ?? 0;
    if (current < quantity) return false;
    this.stock.set(productId, current - quantity);
    return true;
  }

  consumeBatchesFefo(_productId: string, _quantity: number): BatchConsumption[] {
    return [];
  }

  incrementStock(productId: string, quantity: number): void {
    this.stock.set(productId, (this.stock.get(productId) ?? 0) + quantity);
  }

  insertBatch(_data: { productId: string; batchCode: string; quantity: number; expirationDate: Date }): string {
    this.receivedBatch = { productId: _data.productId, quantity: _data.quantity };
    return '';
  }

  insertSale(data: SaleData): string {
    this.sale = data;
    return `${data.shiftId}:${Date.now()}`;
  }

  insertSaleDetails(_saleId: string, items: CartItem[]): void {
    this.items = items;
  }

  insertStockMovement(_m: { productId: string; delta: number; reason: 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN'; referenceId?: string; batchDetail?: BatchConsumption[] }): void {
    return;
  }

  insertCashMovement(_m: CashMovementData): void {
    return;
  }
}
