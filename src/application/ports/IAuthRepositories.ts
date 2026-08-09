import { User } from '../../domain/entities/User';
import { Shift } from '../../domain/entities/Shift';
import { AuditLogEntry } from '../../domain/entities/AuditLogEntry';
import { CashMovement } from '../../domain/entities/CashMovement';

// ── Usuarios ──────────────────────────────────────────────────────────────────

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findAll(): Promise<User[]>;
}

// ── Hasher de PIN ─────────────────────────────────────────────────────────────
// Deliberadamente "lento" (bcrypt/argon2): el login ocurre una vez por turno,
// no por escaneo — aquí la seguridad pesa más que el milisegundo.

export interface IPasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

// ── Report Types ────────────────────────────────────────────────────────────────

export interface SalesByHour {
  hour: number;           // 0-23
  count: number;
  total: number;
  cashTotal: number;
  cardTotal: number;
}

export interface SalesByMethod {
  method: 'CASH' | 'CARD';
  count: number;
  total: number;
}

export interface SalesByCashier {
  cashierId: string;
  cashierName: string;
  count: number;
  total: number;
  cashTotal: number;
  cardTotal: number;
}

export interface ShiftSummary {
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

export interface IShiftRepository {
  create(data: { cashierId: string; registerId: string; openingAmount: number }): Promise<Shift>;
  findById(id: string): Promise<Shift | null>;
  findOpenByRegister(registerId: string): Promise<Shift | null>;
  addCashMovement(shiftId: string, data: { type: 'WITHDRAWAL' | 'DEPOSIT'; amount: number; reason?: string; authorizedBy?: string }): Promise<void>;
  close(id: string, data: { expectedCash: number; countedCash: number; difference: number }): Promise<void>;
  getCashMovements(shiftId: string): Promise<CashMovement[]>;
  getCardSalesTotal(shiftId: string): Promise<number>;

  // Report queries
  getSalesByHour(shiftId: string): Promise<SalesByHour[]>;
  getSalesByMethod(shiftId: string): Promise<SalesByMethod[]>;
  getSalesByCashier(shiftId: string): Promise<SalesByCashier[]>;
  getShiftHistory(registerId?: string, limit?: number): Promise<ShiftSummary[]>;
  getShiftDetail(shiftId: string): Promise<ShiftSummary | null>;
  getTopProducts(shiftId: string, limit?: number): Promise<Array<{ productId: string; sku: string; name: string; quantity: number; total: number }>>;
}

// ── Auditoría ─────────────────────────────────────────────────────────────────

export interface AuditLogData {
  userId: string;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface IAuditLogRepository {
  record(entry: AuditLogData): Promise<void>;
}
