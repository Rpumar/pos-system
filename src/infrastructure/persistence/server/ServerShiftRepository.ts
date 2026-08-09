import { Shift } from '../../../domain/entities/Shift';
import { CashMovement } from '../../../domain/entities/CashMovement';
import {
  IShiftRepository,
  SalesByHour,
  SalesByMethod,
  SalesByCashier,
  ShiftSummary,
} from '../../../application/ports/IAuthRepositories';
import { ApiClient } from '../../http/ApiClient';
import {
  mapShift,
  mapShiftSummary,
  mapCashMovement,
  toSalesByHour,
  toSalesByMethod,
  toSalesByCashier,
} from '../../http/mappers';
import { ServerSessionContext } from './ServerSessionContext';

type DTO = Record<string, unknown>;

const LIST_LIMIT = 10000;

export class ServerShiftRepository implements IShiftRepository {
  private cashierNames: Map<string, string> | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly ctx: ServerSessionContext
  ) {}

  async create(data: { cashierId: string; registerId: string; openingAmount: number }): Promise<Shift> {
    const reg = await this.ctx.resolveRegister(data.registerId);
    const dto = (await this.api.post<DTO>('/turnos', {
      usuario_id: data.cashierId,
      caja_id: reg.cajaId,
      sucursal_id: reg.sucursalId,
      monto_apertura: data.openingAmount,
    })) as DTO;

    const shift = mapShift(dto, reg.cajaNombre);
    this.ctx.setShiftRegister(shift.id, reg);
    this.ctx.markShiftOpen(shift.id);
    return shift;
  }

  async findById(id: string): Promise<Shift | null> {
    try {
      const dto = (await this.api.get<DTO>(`/turnos/${id}`)) as DTO;
      const registerId = String(dto['caja_nombre'] ?? '');
      const shift = mapShift(dto, registerId);
      this.ctx.setShiftRegister(id, {
        cajaId: String(dto['caja_id'] ?? ''),
        sucursalId: String(dto['sucursal_id'] ?? ''),
        cajaNombre: registerId,
      });
      if (shift.isOpen()) this.ctx.markShiftOpen(id);
      return shift;
    } catch {
      return null;
    }
  }

  async findOpenByRegister(registerId: string): Promise<Shift | null> {
    const reg = await this.ctx.resolveRegister(registerId);
    const dto = (await this.api.get<DTO>(`/turnos/abierto/${reg.cajaId}`)) as DTO;
    const turno = (dto['turno'] ?? null) as DTO | null;
    if (!turno) return null;
    const shift = mapShift(turno, reg.cajaNombre);
    this.ctx.setShiftRegister(shift.id, reg);
    this.ctx.markShiftOpen(shift.id);
    return shift;
  }

  async addCashMovement(
    shiftId: string,
    data: { type: 'WITHDRAWAL' | 'DEPOSIT'; amount: number; reason?: string; authorizedBy?: string }
  ): Promise<void> {
    await this.api.post(`/turnos/${shiftId}/movimiento`, {
      tipo: data.type === 'WITHDRAWAL' ? 'RETIRO' : 'DEPOSITO',
      monto: data.amount,
      motivo: data.reason ?? undefined,
      autorizado_por: data.authorizedBy ?? undefined,
    });
  }

  async close(
    id: string,
    data: { expectedCash: number; countedCash: number; difference: number }
  ): Promise<void> {
    await this.api.post(`/turnos/${id}/cerrar`, { monto_contado: data.countedCash });
    this.ctx.markShiftClosed(id);
  }

  async getCashMovements(shiftId: string): Promise<CashMovement[]> {
    const dto = (await this.api.get<DTO>(`/turnos/${shiftId}`)) as DTO;
    const movs = (dto['movimientos'] ?? []) as DTO[];
    return movs
      // APERTURA y CIERRE son registros informativos del arqueo, NO dinero en el
      // cajón: la apertura ya vive en Shift.openingAmount y el cierre se calcula.
      // Incluirlos duplicaría el efectivo esperado en el resumen.
      .filter((m) => String(m['tipo']) !== 'CIERRE' && String(m['tipo']) !== 'APERTURA')
      .map((m) => mapCashMovement(m, shiftId));
  }

  async getCardSalesTotal(shiftId: string): Promise<number> {
    const dto = (await this.api.get<DTO>(`/turnos/${shiftId}`)) as DTO;
    return Number(dto['ventasTarjeta'] ?? 0);
  }

  async getSalesByHour(shiftId: string): Promise<SalesByHour[]> {
    const ventas = await this.salesOfShift(shiftId);
    return toSalesByHour(ventas);
  }

  async getSalesByMethod(shiftId: string): Promise<SalesByMethod[]> {
    const ventas = await this.salesOfShift(shiftId);
    return toSalesByMethod(ventas);
  }

  async getSalesByCashier(shiftId: string): Promise<SalesByCashier[]> {
    const ventas = await this.salesOfShift(shiftId);
    const names = await this.loadCashierNames();
    return toSalesByCashier(ventas, names);
  }

  async getShiftHistory(_registerId?: string, limit?: number): Promise<ShiftSummary[]> {
    const rows = (await this.api.get<unknown[]>(`/turnos?limit=${limit ?? 1000}`)) as DTO[];
    return rows.map(mapShiftSummary);
  }

  async getShiftDetail(shiftId: string): Promise<ShiftSummary | null> {
    try {
      const dto = (await this.api.get<DTO>(`/turnos/${shiftId}`)) as DTO;
      return mapShiftSummary(dto);
    } catch {
      return null;
    }
  }

  async getTopProducts(
    shiftId: string,
    limit = 10
  ): Promise<Array<{ productId: string; sku: string; name: string; quantity: number; total: number }>> {
    const ventas = await this.salesOfShift(shiftId);
    const agg = new Map<string, { sku: string; name: string; quantity: number; total: number }>();

    for (const v of ventas.slice(0, 200)) {
      const detail = (await this.api.get<DTO>(`/ventas/${String(v['id'])}`)) as DTO;
      const detalles = (detail['detalles'] ?? []) as DTO[];
      for (const d of detalles) {
        const pid = String(d['producto_id']);
        const entry =
          agg.get(pid) ?? { sku: String(d['sku'] ?? ''), name: String(d['nombre'] ?? ''), quantity: 0, total: 0 };
        entry.quantity += Number(d['cantidad'] ?? 0);
        entry.total += Number(d['subtotal'] ?? 0);
        agg.set(pid, entry);
      }
    }

    return Array.from(agg.entries())
      .map(([productId, e]) => ({ productId, ...e }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, limit);
  }

  private async salesOfShift(shiftId: string): Promise<DTO[]> {
    return (await this.api.get<unknown[]>(
      `/ventas?turno_id=${shiftId}&limit=${LIST_LIMIT}`
    )) as DTO[];
  }

  private async loadCashierNames(): Promise<Map<string, string>> {
    if (this.cashierNames) return this.cashierNames;
    const rows = (await this.api.get<unknown[]>(`/turnos?limit=1000`)) as DTO[];
    const map = new Map<string, string>();
    for (const r of rows) {
      const id = String(r['usuario_id'] ?? '');
      if (id) map.set(id, String(r['usuario_nombre'] ?? ''));
    }
    this.cashierNames = map;
    return map;
  }
}