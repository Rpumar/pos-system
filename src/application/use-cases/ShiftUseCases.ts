import { Shift } from '../../domain/entities/Shift';
import { CashMovement } from '../../domain/entities/CashMovement';
import { IShiftRepository } from '../ports/IAuthRepositories';
import { ShiftAlreadyOpenError, ShiftNotOpenError } from '../errors/AuthErrors';

// ── OpenShiftUseCase ──────────────────────────────────────────────────────────

export class OpenShiftUseCase {
  constructor(private readonly shiftRepository: IShiftRepository) {}

  async execute(cashierId: string, registerId: string, openingAmount: number): Promise<Shift> {
    const existing = await this.shiftRepository.findOpenByRegister(registerId);
    if (existing) throw new ShiftAlreadyOpenError(registerId);
    return this.shiftRepository.create({ cashierId, registerId, openingAmount });
  }
}

// ── CloseShiftUseCase ─────────────────────────────────────────────────────────

export interface ShiftCloseSummary {
  shiftId: string;
  openingAmount: number;
  totalCashSales: number;
  totalWithdrawals: number;
  totalDeposits: number;
  totalRefunds: number;
  totalCardSales: number;
  expectedCash: number;
  countedCash: number;
  difference: number;
  flagged: boolean;
}

const CASH_TOLERANCE = 1.00; // margen de diferencia aceptable en moneda local

function sumByType(movements: CashMovement[], type: CashMovement['type']): number {
  return movements.filter((m) => m.type === type).reduce((s, m) => s + m.amount, 0);
}

export class CloseShiftUseCase {
  constructor(private readonly shiftRepository: IShiftRepository) {}

  async execute(shiftId: string, countedCash: number): Promise<ShiftCloseSummary> {
    const shift = await this.shiftRepository.findById(shiftId);
    if (!shift?.isOpen()) throw new ShiftNotOpenError(shiftId);

    const movements = await this.shiftRepository.getCashMovements(shiftId);
    const totalCashSales   = sumByType(movements, 'SALE_CASH');
    const totalWithdrawals = sumByType(movements, 'WITHDRAWAL');
    const totalDeposits    = sumByType(movements, 'DEPOSIT');
    // Las devoluciones (REFUND) son SALIDAS de efectivo ya devueltas al cliente:
    // se restan del esperado exactamente igual que el servidor en el ledger.
    const totalRefunds     = sumByType(movements, 'REFUND');
    const totalCardSales   = await this.shiftRepository.getCardSalesTotal(shiftId);

    // Lo que DEBERÍA haber en el cajón según el sistema:
    const expectedCash = shift.openingAmount + totalCashSales + totalRefunds + totalDeposits - totalWithdrawals;
    const difference   = countedCash - expectedCash;
    const flagged      = Math.abs(difference) > CASH_TOLERANCE;

    await this.shiftRepository.close(shiftId, { expectedCash, countedCash, difference });

    return {
      shiftId,
      openingAmount: shift.openingAmount,
      totalCashSales,
      totalWithdrawals,
      totalDeposits,
      totalRefunds,
      totalCardSales,
      expectedCash,
      countedCash,
      difference,
      flagged,
    };
  }
}
