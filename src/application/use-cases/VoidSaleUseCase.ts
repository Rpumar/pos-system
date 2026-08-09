import { IUnitOfWork } from '../ports/IUnitOfWork';
import { IAuditLogRepository } from '../ports/IAuthRepositories';

export interface VoidSaleInput {
  saleId: string;
  cashierId: string;
  reason: string;
}

export class SaleNotFoundError extends Error {
  constructor(saleId: string) {
    super(`Venta ${saleId} no encontrada o ya anulada`);
    this.name = 'SaleNotFoundError';
  }
}

export class VoidSaleUseCase {
  constructor(
    private readonly unitOfWork: IUnitOfWork,
    private readonly auditLog: IAuditLogRepository
  ) {}

  async execute(input: VoidSaleInput): Promise<void> {
    await this.unitOfWork.execute((tx) => {
      const sale = tx.findSaleById(input.saleId);
      if (!sale) throw new SaleNotFoundError(input.saleId);
      for (const detail of sale.details) {
        tx.incrementStock(detail.productId, detail.quantity);
        tx.insertStockMovement({
          productId: detail.productId,
          delta: detail.quantity,
          reason: 'RETURN',
          referenceId: input.saleId,
        });
      }
      // La venta en efectivo fue COBRADA al cliente: al anularla ese efectivo
      // sale del cajón. Se registra el movimiento REFUND (negativo) para que el
      // arqueo del turno reste el monto devuelto (misma lógica que el servidor).
      if (sale.paymentMethod === 'CASH' && sale.total > 0) {
        tx.insertCashMovement({
          shiftId: sale.shiftId,
          type: 'REFUND',
          amount: -sale.total,
          referenceId: sale.id,
        });
      }
      tx.voidSale(input.saleId, input.reason);
    });
    await this.auditLog.record({
      userId: input.cashierId,
      action: 'VOID_SALE',
      entity: 'sales',
      entityId: input.saleId,
      metadata: { reason: input.reason },
    });
  }
}
