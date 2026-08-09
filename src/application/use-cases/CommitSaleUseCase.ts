import { Cart } from '../../domain/entities/Cart';
import { Sale, SaleDetail } from '../../domain/entities/Sale';
import { IUnitOfWork } from '../ports/IUnitOfWork';
import { StockConflictError, NoActiveShiftError } from '../errors/StockErrors';

/**
 * Confirma una venta ya pagada: descuenta stock agregado, consume lotes
 * en orden FEFO, persiste la venta y su detalle, y —si fue en efectivo—
 * registra el movimiento de caja para el arqueo del turno.
 *
 * Todo ocurre como UNA sola transacción atómica (Unit of Work). Si
 * cualquier paso falla, se revierte absolutamente todo: nunca queda
 * una venta "a medias" ni un stock descontado sin su lote consumido.
 */
export class CommitSaleUseCase {
  constructor(private readonly unitOfWork: IUnitOfWork) {}

  async execute(
    cart: Cart,
    shiftId: string,
    cashierId: string,
    method: 'CASH' | 'CARD',
    authCode?: string
  ): Promise<Sale> {
    return this.unitOfWork.execute((tx) => {
      const shift = tx.findOpenShift(shiftId);
      if (!shift) throw new NoActiveShiftError(shiftId);

      const items = cart.getItems();
      const saleId = tx.insertSale({
        shiftId,
        cashierId,
        total: cart.total,
        method,
        authCode,
        status: 'PAID',
      });

      for (const item of items) {
        const ok = tx.decrementStock(item.productId, item.quantity);
        if (!ok) throw new StockConflictError(item.sku, item.quantity);

        // Trazabilidad por lote: queda registrado qué lote específico
        // cubrió esta venta, indispensable ante un reclamo o un recall.
        const consumed = tx.consumeBatchesFefo(item.productId, item.quantity);

        tx.insertStockMovement({
          productId: item.productId,
          delta: -item.quantity,
          reason: 'SALE',
          referenceId: saleId,
          batchDetail: consumed,
        });
      }

      tx.insertSaleDetails(saleId, items);

      if (method === 'CASH') {
        tx.insertCashMovement({ shiftId, type: 'SALE_CASH', amount: cart.total, referenceId: saleId });
      }

      const details = items.map(
        (i) => new SaleDetail(i.productId, i.quantity, i.unitPrice, i.subtotal)
      );
      return new Sale(saleId, shiftId, cashierId, details, cart.total, 'PAID', method, authCode);
    });
  }
}
