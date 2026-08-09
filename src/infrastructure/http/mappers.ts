import { Product } from '../../domain/entities/Product';
import { User, UserRole } from '../../domain/entities/User';
import { Shift, ShiftStatus } from '../../domain/entities/Shift';
import { CashMovement, CashMovementType } from '../../domain/entities/CashMovement';
import {
  SalesByHour,
  SalesByMethod,
  SalesByCashier,
  ShiftSummary,
} from '../../application/ports/IAuthRepositories';

interface DTO {
  [key: string]: unknown;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function date(v: unknown): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function mapProduct(dto: DTO): Product {
  const activo = dto['activo'] === undefined ? 1 : dto['activo'];
  return new Product(
    str(dto['id']),
    str(dto['sku']),
    str(dto['barcode']),
    str(dto['nombre']),
    num(dto['precio']),
    num(dto['stock_sucursal'] ?? dto['stock_central'] ?? 0),
    activo !== 0
  );
}

export function mapRole(role: unknown): UserRole {
  if (role === 'ADMIN') return 'ADMIN';
  if (role === 'SUPERVISOR') return 'SUPERVISOR';
  return 'CASHIER';
}

export function mapUser(dto: DTO): User {
  return new User(str(dto['id']), str(dto['nombre'] ?? dto['name']), '', mapRole(dto['role']), true);
}

export function mapShiftStatus(estado: unknown): ShiftStatus {
  // Solo 'ABIERTO' es un turno en curso. CERRADO y CON_DESCUADRE son turnos
  // finalizados (CON_DESCUADRE se cierra con diferencia fuera de tolerancia,
  // NO está abierto) — de lo contrario un turno cerrado con descuadre se
  // reabriría en la UI, vulnerando el ciclo de caja.
  return str(estado) === 'ABIERTO' ? 'OPEN' : 'CLOSED';
}

export function mapShift(dto: DTO, registerId: string): Shift {
  const status = mapShiftStatus(dto['estado']);
  const closedAt = date(dto['closed_at']);
  return new Shift(
    str(dto['id']),
    str(dto['usuario_id']),
    registerId,
    num(dto['monto_apertura']),
    status,
    date(dto['opened_at']) ?? new Date(),
    dto['monto_esperado'] === undefined || dto['monto_esperado'] === null ? undefined : num(dto['monto_esperado']),
    dto['monto_contado'] === undefined || dto['monto_contado'] === null ? undefined : num(dto['monto_contado']),
    dto['diferencia'] === undefined || dto['diferencia'] === null ? undefined : num(dto['diferencia']),
    closedAt
  );
}

const MOVEMENT_TYPE_MAP: Record<string, CashMovementType> = {
  VENTA_EFECTIVO: 'SALE_CASH',
  RETIRO: 'WITHDRAWAL',
  DEPOSITO: 'DEPOSIT',
  DEVOLUCION: 'REFUND',
};

export function mapCashMovement(dto: DTO, shiftId: string): CashMovement {
  // Tipo de movimiento desconocido => error claro en lugar de distorsionar
  // silenciosamente el efectivo esperado del cajón.
  const tipo = MOVEMENT_TYPE_MAP[str(dto['tipo'])];
  if (!tipo) {
    throw new Error(`Movimiento de caja con tipo inesperado: ${str(dto['tipo'])}`);
  }
  return new CashMovement(
    str(dto['id']),
    shiftId,
    tipo,
    num(dto['monto']),
    dto['motivo'] === null || dto['motivo'] === undefined ? undefined : str(dto['motivo']),
    dto['autorizado_por'] === null || dto['autorizado_por'] === undefined ? undefined : str(dto['autorizado_por']),
    dto['referencia_id'] === null || dto['referencia_id'] === undefined ? undefined : str(dto['referencia_id']),
    date(dto['created_at']) ?? new Date()
  );
}

export function mapShiftSummary(dto: DTO): ShiftSummary {
  const status = mapShiftStatus(dto['estado']);
  return {
    id: str(dto['id']),
    cashierId: str(dto['usuario_id']),
    cashierName: str(dto['usuario_nombre'] ?? dto['nombre']),
    registerId: str(dto['caja_nombre']),
    openingAmount: num(dto['monto_apertura']),
    expectedCash: dto['monto_esperado'] === undefined || dto['monto_esperado'] === null ? null : num(dto['monto_esperado']),
    countedCash: dto['monto_contado'] === undefined || dto['monto_contado'] === null ? null : num(dto['monto_contado']),
    difference: dto['diferencia'] === undefined || dto['diferencia'] === null ? null : num(dto['diferencia']),
    status: status === 'OPEN' ? 'OPEN' : status,
    openedAt: date(dto['opened_at']) ?? new Date(),
    closedAt: date(dto['closed_at']) ?? null,
    totalSales: num(dto['totalVentas'] ?? dto['total']),
    totalCashSales: num(dto['ventasEfectivo']),
    totalCardSales: num(dto['ventasTarjeta']),
    saleCount: num(dto['ventas_count']),
  };
}

export function mapPaymentMethod(method: unknown): 'CASH' | 'CARD' {
  return str(method) === 'TARJETA' ? 'CARD' : 'CASH';
}

export function toSalesByHour(ventas: DTO[]): SalesByHour[] {
  const map = new Map<number, SalesByHour>();
  for (const v of ventas) {
    const d = date(v['created_at']);
    const hour = (d ? d.getHours() : 0) as number;
    const entry = map.get(hour) ?? { hour, count: 0, total: 0, cashTotal: 0, cardTotal: 0 };
    const total = num(v['total']);
    const method = mapPaymentMethod(v['metodo_pago']);
    entry.count += 1;
    entry.total += total;
    if (method === 'CASH') entry.cashTotal += total;
    else entry.cardTotal += total;
    map.set(hour, entry);
  }
  return Array.from(map.values()).sort((a, b) => a.hour - b.hour);
}

export function toSalesByMethod(ventas: DTO[]): SalesByMethod[] {
  const cash: SalesByMethod = { method: 'CASH', count: 0, total: 0 };
  const card: SalesByMethod = { method: 'CARD', count: 0, total: 0 };
  for (const v of ventas) {
    const method = mapPaymentMethod(v['metodo_pago']);
    const total = num(v['total']);
    if (method === 'CASH') {
      cash.count += 1;
      cash.total += total;
    } else {
      card.count += 1;
      card.total += total;
    }
  }
  return [cash, card];
}

export function toSalesByCashier(
  ventas: DTO[],
  cashierNames: Map<string, string>
): SalesByCashier[] {
  const map = new Map<string, SalesByCashier>();
  for (const v of ventas) {
    const cashierId = str(v['usuario_id']);
    const entry =
      map.get(cashierId) ??
      ({ cashierId, cashierName: cashierNames.get(cashierId) ?? '', count: 0, total: 0, cashTotal: 0, cardTotal: 0 } as SalesByCashier);
    const total = num(v['total']);
    const method = mapPaymentMethod(v['metodo_pago']);
    entry.count += 1;
    entry.total += total;
    if (method === 'CASH') entry.cashTotal += total;
    else entry.cardTotal += total;
    map.set(cashierId, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}