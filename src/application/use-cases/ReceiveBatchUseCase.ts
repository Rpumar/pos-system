import { IUnitOfWork } from '../ports/IUnitOfWork';

/**
 * Da de alta un lote nuevo y su contraparte simétrica en products.stock,
 * dentro de la misma transacción — mantiene el invariante
 * products.stock === SUM(batches.quantity) en todo momento.
 */
export class ReceiveBatchUseCase {
  constructor(private readonly unitOfWork: IUnitOfWork) {}

  async execute(
    productId: string,
    batchCode: string,
    quantity: number,
    expirationDate: Date
  ): Promise<void> {
    if (quantity <= 0) throw new Error('La cantidad recibida debe ser mayor a cero');

    await this.unitOfWork.execute((tx) => {
      tx.insertBatch({ productId, batchCode, quantity, expirationDate });
      tx.incrementStock(productId, quantity);
      tx.insertStockMovement({
        productId,
        delta: quantity,
        reason: 'RESTOCK',
        referenceId: batchCode,
      });
    });
  }
}
