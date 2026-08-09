export type CashMovementType = 'SALE_CASH' | 'WITHDRAWAL' | 'DEPOSIT' | 'REFUND';

/**
 * Entidad de dominio. Cada movimiento de dinero físico dentro de un
 * turno. La suma de estos es la base del cálculo de expectedCash
 * en CloseShiftUseCase (Módulo 6).
 */
export class CashMovement {
  constructor(
    public readonly id: string,
    public readonly shiftId: string,
    public readonly type: CashMovementType,
    public readonly amount: number,
    public readonly reason?: string,
    public readonly authorizedBy?: string,
    public readonly referenceId?: string,
    public readonly createdAt: Date = new Date()
  ) {}
}
