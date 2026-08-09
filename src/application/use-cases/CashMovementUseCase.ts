import { IShiftRepository } from '../ports/IAuthRepositories';

export interface CashMovementInput {
  shiftId: string;
  type: 'WITHDRAWAL' | 'DEPOSIT';
  amount: number;
  reason?: string;
  authorizedBy?: string;
}

/**
 * Registra un retiro o depósito de efectivo del cajón dentro del turno.
 * Los retiros exigen autorización de supervisor (decorator) porque
 * representan salida de dinero del cajón; los depósitos no.
 */
export class RegisterCashMovementUseCase {
  constructor(private readonly shiftRepository: IShiftRepository) {}

  async execute(input: CashMovementInput): Promise<void> {
    if (input.amount <= 0) throw new Error('El monto debe ser mayor a cero');
    await this.shiftRepository.addCashMovement(input.shiftId, {
      type: input.type,
      amount: input.amount,
      reason: input.reason,
      authorizedBy: input.authorizedBy,
    });
  }
}
