export type StockMovementReason = 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN';

export interface BatchDetail {
  batchId: string;
  batchCode: string;
  quantityTaken: number;
}

/**
 * Entidad de dominio. Registro inmutable de auditoría: responde
 * "por qué cambió el stock" ante cualquier reclamo o descuadre.
 */
export class StockMovement {
  constructor(
    public readonly id: string,
    public readonly productId: string,
    public readonly delta: number,
    public readonly reason: StockMovementReason,
    public readonly referenceId?: string,
    public readonly batchDetail?: BatchDetail[],
    public readonly createdAt: Date = new Date()
  ) {}
}
