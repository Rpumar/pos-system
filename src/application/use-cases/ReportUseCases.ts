import { IShiftRepository } from '../ports/IAuthRepositories';
import { Shift } from '../../domain/entities/Shift';
import { CashMovement } from '../../domain/entities/CashMovement';

export interface XReportData {
  shift: Shift;
  openingAmount: number;
  totalCashSales: number;
  totalWithdrawals: number;
  totalDeposits: number;
  totalCardSales: number;
  expectedCash: number;
  saleCount: number;
  salesByHour: Array<{ hour: number; count: number; total: number; cashTotal: number; cardTotal: number }>;
  salesByMethod: Array<{ method: 'CASH' | 'CARD'; count: number; total: number }>;
  salesByCashier: Array<{ cashierId: string; cashierName: string; count: number; total: number; cashTotal: number; cardTotal: number }>;
  topProducts: Array<{ productId: string; sku: string; name: string; quantity: number; total: number }>;
  cashMovements: CashMovement[];
}

export interface ZReportData extends XReportData {
  countedCash: number;
  difference: number;
  flagged: boolean;
  closedAt: Date;
}

export interface ShiftHistoryItem {
  id: string;
  cashierId: string;
  cashierName: string;
  registerId: string;
  openingAmount: number;
  expectedCash: number | null;
  countedCash: number | null;
  difference: number | null;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  totalSales: number;
  totalCashSales: number;
  totalCardSales: number;
  saleCount: number;
}

const CASH_TOLERANCE = 1.00;

function sumByType(movements: CashMovement[], type: CashMovement['type']): number {
  return movements.filter((m) => m.type === type).reduce((s, m) => s + m.amount, 0);
}

export class GetXReportUseCase {
  constructor(private readonly shiftRepo: IShiftRepository) {}

  async execute(shiftId: string): Promise<XReportData> {
    const shift = await this.shiftRepo.findById(shiftId);
    if (!shift) throw new Error('Turno no encontrado');

    const movements = await this.shiftRepo.getCashMovements(shiftId);
    const totalCashSales = sumByType(movements, 'SALE_CASH');
    const totalWithdrawals = sumByType(movements, 'WITHDRAWAL');
    const totalDeposits = sumByType(movements, 'DEPOSIT');
    const totalCardSales = await this.shiftRepo.getCardSalesTotal(shiftId);

    const expectedCash = shift.openingAmount + totalCashSales + totalDeposits - totalWithdrawals;

    const [salesByHour, salesByMethod, salesByCashier, topProducts] = await Promise.all([
      this.shiftRepo.getSalesByHour(shiftId),
      this.shiftRepo.getSalesByMethod(shiftId),
      this.shiftRepo.getSalesByCashier(shiftId),
      this.shiftRepo.getTopProducts(shiftId, 10),
    ]);

    return {
      shift,
      openingAmount: shift.openingAmount,
      totalCashSales,
      totalWithdrawals,
      totalDeposits,
      totalCardSales,
      expectedCash,
      saleCount: salesByHour.reduce((s, h) => s + h.count, 0),
      salesByHour,
      salesByMethod,
      salesByCashier,
      topProducts,
      cashMovements: movements,
    };
  }
}

export class GetZReportUseCase {
  constructor(private readonly shiftRepo: IShiftRepository) {}

  async execute(shiftId: string, countedCash: number): Promise<ZReportData> {
    const xReport = await new GetXReportUseCase(this.shiftRepo).execute(shiftId);

    const shift = await this.shiftRepo.findById(shiftId);
    if (!shift?.isOpen()) throw new Error('Turno no está abierto');

    const difference = countedCash - xReport.expectedCash;
    const flagged = Math.abs(difference) > CASH_TOLERANCE;

    await this.shiftRepo.close(shiftId, {
      expectedCash: xReport.expectedCash,
      countedCash,
      difference,
    });

    const closedShift = await this.shiftRepo.findById(shiftId);

    return {
      ...xReport,
      countedCash,
      difference,
      flagged,
      closedAt: closedShift?.closedAt ?? new Date(),
    };
  }
}

export class GetShiftHistoryUseCase {
  constructor(private readonly shiftRepo: IShiftRepository) {}

  async execute(registerId?: string, limit = 50): Promise<ShiftHistoryItem[]> {
    return this.shiftRepo.getShiftHistory(registerId, limit);
  }
}

export class GetShiftDetailUseCase {
  constructor(private readonly shiftRepo: IShiftRepository) {}

  async execute(shiftId: string): Promise<ShiftHistoryItem | null> {
    return this.shiftRepo.getShiftDetail(shiftId);
  }
}