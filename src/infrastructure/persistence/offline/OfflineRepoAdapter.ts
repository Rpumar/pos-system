import { Product } from '../../../domain/entities/Product';
import { Shift } from '../../../domain/entities/Shift';
import { CashMovement } from '../../../domain/entities/CashMovement';
import { CartItem } from '../../../domain/entities/Cart';
import {
  IShiftRepository,
  SalesByHour,
  SalesByMethod,
  SalesByCashier,
  ShiftSummary,
} from '../../../application/ports/IAuthRepositories';
import {
  IUnitOfWork,
  ITransaction,
  SaleData,
  SaleRow,
  BatchConsumption,
  CashMovementData,
} from '../../../application/ports/IUnitOfWork';
import { IProductRepository } from '../../../application/ports/IProductRepository';
import { OfflineDB } from './OfflineDB';
import { OutboxManager } from './OutboxManager';
import { NetworkDetector } from './NetworkDetector';
import { mapCashMovement, mapProduct, mapShift } from '../../http/mappers';

type DTO = Record<string, unknown>;

export interface RegisterResolutionCache {
  cajaId: string;
  sucursalId: string;
  cajaNombre: string;
}

/**
 * Dependencias compartidas por los adaptadores offline. El estado en memoria
 * (turnos abiertos + registros de caja resueltos) es síncrono a propósito:
 * ITransaction exige métodos síncronos y la venta offline no puede esperar DB.
 */
export interface OfflineDeps {
  db: OfflineDB;
  outbox: OutboxManager;
  isOnline(): boolean;
  register(registerId: string): Promise<RegisterResolutionCache | null>;
  cacheRegister(registerId: string, resolution: RegisterResolutionCache): Promise<void>;
  /** Resolución viva (HTTP) inyectada por el container; null si offline */
  resolveLive?(registerId: string): Promise<RegisterResolutionCache | null>;
  openShifts: Set<string>;
  markOpen(shiftId: string): void;
  markClosed(shiftId: string): void;
  shiftRegisters: Map<string, RegisterResolutionCache>;
  setShiftRegister(shiftId: string, resolution: RegisterResolutionCache): void;
  /** Permitir a la UI refrescar pendientes tras cada operación */
  notify?(): void;
  /** Hookeo para propagar el caja_id resuelto al SyncManager */
  onCajaResolved?(cajaId: string): void;
}

export function buildOfflineDeps(
  db: OfflineDB,
  outbox: OutboxManager,
  networkDetector: NetworkDetector | null
): OfflineDeps {
  const openShifts = new Set<string>();
  const shiftRegisters = new Map<string, RegisterResolutionCache>();

  return {
    db,
    outbox,
    isOnline: () => (networkDetector ? networkDetector.getStatus() !== 'offline' : true),
    register: async (registerId: string) => {
      const meta = await db.get<{ value: RegisterResolutionCache }>('meta', `register:${registerId}`);
      return meta?.value ?? null;
    },
    cacheRegister: async (registerId, resolution) => {
      await db.put('meta', { id: `register:${registerId}`, value: resolution, updatedAt: Date.now() });
    },
    openShifts,
    markOpen: (id) => openShifts.add(id),
    markClosed: (id) => openShifts.delete(id),
    shiftRegisters,
    setShiftRegister: (id, resolution) => shiftRegisters.set(id, resolution),
  };
}

function localId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isOpen(localShift: DTO): boolean {
  return String(localShift['estado'] ?? '') === 'ABIERTO';
}

// ─── Turnos ───────────────────────────────────────────────────────────────────

export class OfflineShiftRepository implements IShiftRepository {
  constructor(
    private readonly online: IShiftRepository,
    private readonly deps: OfflineDeps
  ) {}

  async create(data: { cashierId: string; registerId: string; openingAmount: number }): Promise<Shift> {
    const reg = (this.deps.resolveLive ? await this.deps.resolveLive(data.registerId) : null)
      ?? await this.deps.register(data.registerId);
    if (reg?.cajaId) await this.deps.cacheRegister(data.registerId, reg);

    if (this.deps.isOnline()) {
      const shift = await this.online.create(data);
      if (reg?.cajaId) {
        await this.mirrorOpenShift(shift, reg);
        this.deps.onCajaResolved?.(reg.cajaId);
      }
      return shift;
    }

    if (!reg || !reg.cajaId) {
      throw new Error('Sin caja configurada para operar offline. Conectate al menos una vez para resolver esta caja.');
    }

    const id = localId('shift');
    const openedAt = new Date().toISOString();
    const local: DTO = {
      id,
      caja_id: reg.cajaId,
      sucursal_id: reg.sucursalId,
      caja_nombre: reg.cajaNombre,
      usuario_id: data.cashierId,
      monto_apertura: data.openingAmount,
      estado: 'ABIERTO',
      status: 'OPEN',
      opened_at: openedAt,
    };
    await this.deps.db.put('shifts', local as never);

    await this.deps.outbox.enqueue('CREATE_SHIFT', {
      id,
      caja_id: reg.cajaId,
      sucursal_id: reg.sucursalId,
      usuario_id: data.cashierId,
      monto_apertura: data.openingAmount,
      opened_at: openedAt,
    });

    this.deps.setShiftRegister(id, reg);
    this.deps.markOpen(id);
    this.deps.onCajaResolved?.(reg.cajaId);
    this.deps.notify?.();
    return new Shift(id, data.cashierId, reg.cajaNombre, data.openingAmount, 'OPEN', new Date(openedAt));
  }

  async findById(id: string): Promise<Shift | null> {
    if (this.deps.isOnline()) return this.online.findById(id);
    const rec = await this.deps.db.get<DTO>('shifts', id);
    if (!rec) return null;
    this.trackRecord(rec);
    return mapShift(rec, String(rec['caja_nombre'] ?? ''));
  }

  async findOpenByRegister(registerId: string): Promise<Shift | null> {
    if (this.deps.isOnline()) {
      const shift = await this.online.findOpenByRegister(registerId);
      if (shift?.isOpen()) {
        const reg = this.deps.resolveLive ? await this.deps.resolveLive(registerId) : null;
        if (reg?.cajaId) await this.mirrorOpenShift(shift, reg);
      }
      return shift;
    }
    const reg = await this.deps.register(registerId);
    const all = await this.deps.db.getAll<DTO>('shifts');
    const rec = all.find((r) => isOpen(r) && String(r['caja_nombre'] ?? '') === registerId);
    if (!rec) return null;
    this.trackRecord(rec);
    return mapShift(rec, String(rec['caja_nombre'] ?? registerId));
  }

  async addCashMovement(
    shiftId: string,
    data: { type: 'WITHDRAWAL' | 'DEPOSIT'; amount: number; reason?: string; authorizedBy?: string }
  ): Promise<void> {
    if (this.deps.isOnline()) {
      await this.online.addCashMovement(shiftId, data);
      return;
    }
    const id = localId('cashmov');
    const tipo = data.type === 'WITHDRAWAL' ? 'RETIRO' : 'DEPOSITO';
    const createdAt = new Date().toISOString();
    await this.deps.db.put('cash_movements', {
      id,
      shiftId,
      tipo,
      monto: data.amount,
      motivo: data.reason,
      autorizado_por: data.authorizedBy,
      created_at: createdAt,
    } as never);
    await this.deps.outbox.enqueue('CREATE_CASH_MOVEMENT', {
      id,
      turno_id: shiftId,
      tipo,
      monto: data.amount,
      motivo: data.reason ?? undefined,
      autorizado_por: data.authorizedBy ?? undefined,
      created_at: createdAt,
    });
    this.deps.notify?.();
  }

  async close(
    id: string,
    data: { expectedCash: number; countedCash: number; difference: number }
  ): Promise<void> {
    if (this.deps.isOnline()) {
      await this.online.close(id, data);
      return;
    }
    const flagged = Math.abs(data.difference) > 1;
    await this.deps.db.put('shifts', {
      id,
      status: 'CLOSED',
      estado: flagged ? 'CON_DESCUADRE' : 'CERRADO',
      monto_contado: data.countedCash,
      monto_esperado: data.expectedCash,
      diferencia: data.difference,
      closed_at: new Date().toISOString(),
    } as never);
    await this.deps.outbox.enqueue('CLOSE_SHIFT', {
      id,
      monto_contado: data.countedCash,
      monto_esperado: data.expectedCash,
      diferencia: data.difference,
      flagged,
    });
    this.deps.markClosed(id);
    this.deps.notify?.();
  }

  async getCashMovements(shiftId: string): Promise<CashMovement[]> {
    if (this.deps.isOnline()) return this.online.getCashMovements(shiftId);
    const all = await this.deps.db.getAll<DTO>('cash_movements');
    return all
      .filter((m) => String(m['shiftId'] ?? m['turno_id'] ?? '') === shiftId)
      .map((m) => mapCashMovement(m, shiftId));
  }

  async getCardSalesTotal(shiftId: string): Promise<number> {
    if (this.deps.isOnline()) return this.online.getCardSalesTotal(shiftId);
    const all = await this.deps.db.getAll<DTO>('sales');
    return all
      .filter((s) => String(s['shiftId']) === shiftId && s['metodo_pago'] === 'TARJETA' && s['status'] !== 'VOIDED')
      .reduce((acc, s) => acc + Number(s['total'] ?? 0), 0);
  }

  async getSalesByHour(_shiftId: string): Promise<SalesByHour[]> {
    if (this.deps.isOnline()) return this.online.getSalesByHour(_shiftId);
    return [];
  }

  async getSalesByMethod(_shiftId: string): Promise<SalesByMethod[]> {
    if (this.deps.isOnline()) return this.online.getSalesByMethod(_shiftId);
    return [];
  }

  async getSalesByCashier(_shiftId: string): Promise<SalesByCashier[]> {
    if (this.deps.isOnline()) return this.online.getSalesByCashier(_shiftId);
    return [];
  }

  async getShiftHistory(_registerId?: string, _limit?: number): Promise<ShiftSummary[]> {
    if (this.deps.isOnline()) return this.online.getShiftHistory(_registerId, _limit);
    return [];
  }

  async getShiftDetail(shiftId: string): Promise<ShiftSummary | null> {
    if (this.deps.isOnline()) return this.online.getShiftDetail(shiftId);
    const rec = await this.deps.db.get<DTO>('shifts', shiftId);
    if (!rec) return null;
    return {
      id: String(rec['id']),
      cashierId: String(rec['usuario_id'] ?? ''),
      cashierName: '',
      registerId: String(rec['caja_nombre'] ?? ''),
      openingAmount: Number(rec['monto_apertura'] ?? 0),
      expectedCash: rec['monto_esperado'] == null ? null : Number(rec['monto_esperado']),
      countedCash: rec['monto_contado'] == null ? null : Number(rec['monto_contado']),
      difference: rec['diferencia'] == null ? null : Number(rec['diferencia']),
      status: isOpen(rec) ? 'OPEN' : 'CLOSED',
      openedAt: new Date(String(rec['opened_at'] ?? Date.now())),
      closedAt: rec['closed_at'] ? new Date(String(rec['closed_at'])) : null,
      totalSales: 0,
      totalCashSales: 0,
      totalCardSales: 0,
      saleCount: 0,
    };
  }

  async getTopProducts(
    _shiftId: string,
    _limit?: number
  ): Promise<Array<{ productId: string; sku: string; name: string; quantity: number; total: number }>> {
    if (this.deps.isOnline()) return this.online.getTopProducts(_shiftId, _limit);
    return [];
  }

  private trackRecord(rec: DTO): void {
    const reg: RegisterResolutionCache = {
      cajaId: String(rec['caja_id'] ?? ''),
      sucursalId: String(rec['sucursal_id'] ?? ''),
      cajaNombre: String(rec['caja_nombre'] ?? ''),
    };
    if (reg.cajaId) this.deps.setShiftRegister(String(rec['id']), reg);
    if (isOpen(rec)) this.deps.markOpen(String(rec['id']));
  }

  /**
   * Espeja un turno abierto en OfflineDB para que un corte de red a mitad de
   * turno (abierto estando online) pueda seguir operando offline.
   */
  private async mirrorOpenShift(shift: Shift, reg: RegisterResolutionCache): Promise<void> {
    await this.deps.db.put('shifts', {
      id: shift.id,
      caja_id: reg.cajaId,
      sucursal_id: reg.sucursalId,
      caja_nombre: reg.cajaNombre,
      usuario_id: shift.cashierId,
      monto_apertura: shift.openingAmount,
      estado: 'ABIERTO',
      status: 'OPEN',
      opened_at: shift.openedAt.toISOString(),
    } as never);
    this.deps.setShiftRegister(shift.id, reg);
    this.deps.markOpen(shift.id);
  }
}

// ─── Unit of Work (venta / anulación / recepción) ────────────────────────────

export class OfflineUnitOfWork implements IUnitOfWork {
  constructor(
    private readonly online: IUnitOfWork,
    private readonly deps: OfflineDeps
  ) {}

  async execute<T>(work: (tx: ITransaction) => T): Promise<T> {
    if (this.deps.isOnline()) return this.online.execute(work);

    const stock = await this.loadStock();
    const localSales = await this.loadLocalSales();
    const tx = new OfflineTransaction(this.deps, stock, localSales);
    const result = work(tx);

    if (tx.sale) await this.persistSale(tx);
    if (tx.voidSaleId) await this.persistVoid(tx);
    if (tx.receivedBatch) throw new Error('Recepción de stock requiere conexión');

    return result;
  }

  private async loadStock(): Promise<Map<string, number>> {
    const rows = await this.deps.db.getAll<DTO>('stock_sucursal');
    return rows.reduce((acc, r) => {
      acc.set(String(r['producto_id']), Number(r['cantidad'] ?? 0));
      return acc;
    }, new Map<string, number>());
  }

  private async loadLocalSales(): Promise<Map<string, SaleRow>> {
    const sales = await this.deps.db.getAll<DTO>('sales');
    const details = await this.deps.db.getAll<DTO>('sale_details');
    return sales.reduce((acc, s) => {
      acc.set(String(s['id']), {
        id: String(s['id']),
        shiftId: String(s['shiftId'] ?? ''),
        paymentMethod: String(s['metodo_pago']) === 'TARJETA' ? 'CARD' : 'CASH',
        total: Number(s['total'] ?? 0),
        details: details
          .filter((d) => String(d['saleId']) === String(s['id']))
          .map((d) => ({ productId: String(d['producto_id']), quantity: Number(d['cantidad'] ?? 0) })),
      });
      return acc;
    }, new Map<string, SaleRow>());
  }

  private async persistSale(tx: OfflineTransaction): Promise<void> {
    const sale = tx.sale;
    if (!sale) return;
    const saleId = tx.saleId ?? '';
    if (!saleId) throw new Error('Venta local sin id');

    const shiftRec = await this.deps.db.get<DTO>('shifts', sale.shiftId);
    if (!shiftRec || !isOpen(shiftRec)) {
      throw new Error(`Turno ${sale.shiftId} no está abierto localmente`);
    }

    const reg: RegisterResolutionCache = {
      cajaId: String(shiftRec['caja_id'] ?? ''),
      sucursalId: String(shiftRec['sucursal_id'] ?? ''),
      cajaNombre: String(shiftRec['caja_nombre'] ?? ''),
    };

    const created_at = new Date().toISOString();
    const detalles = tx.items.map((i) => {
      const subtotal = i.subtotal ?? Math.round(i.unitPrice * i.quantity * 100) / 100;
      return {
        producto_id: i.productId,
        cantidad: i.quantity,
        precio_unitario: i.unitPrice,
        impuesto: 0,
        subtotal,
      };
    });
    const subtotal = Math.round(detalles.reduce((s, d) => s + d.subtotal, 0) * 100) / 100;

    await this.deps.outbox.enqueue('CREATE_SALE', {
      id: saleId,
      turno_id: sale.shiftId,
      caja_id: reg.cajaId,
      sucursal_id: reg.sucursalId,
      usuario_id: sale.cashierId,
      metodo_pago: sale.method === 'CASH' ? 'EFECTIVO' : 'TARJETA',
      codigo_autorizacion: sale.authCode ?? undefined,
      detalles: detalles.map(({ subtotal: _st, ...d }) => d),
      total: sale.total,
      subtotal,
      impuestos: 0,
      created_at,
    });

    await this.deps.db.put('sales', {
      id: saleId,
      shiftId: sale.shiftId,
      caja_id: reg.cajaId,
      sucursal_id: reg.sucursalId,
      usuario_id: sale.cashierId,
      metodo_pago: sale.method === 'CASH' ? 'EFECTIVO' : 'TARJETA',
      codigo_autorizacion: sale.authCode ?? null,
      total: sale.total,
      subtotal,
      impuestos: 0,
      status: 'PAID',
      created_at,
    } as never);

    for (const d of detalles) {
      await this.deps.db.put('sale_details', {
        id: localId('sd'),
        saleId,
        ...d,
      } as never);
    }

    if (sale.method === 'CASH') {
      await this.deps.db.put('cash_movements', {
        id: localId('cashmov'),
        shiftId: sale.shiftId,
        tipo: 'VENTA_EFECTIVO',
        monto: sale.total,
        referencia_id: saleId,
        created_at,
      } as never);
    }

    for (const item of tx.items) {
      await this.applyStockDelta(item.productId, -item.quantity);
    }

    this.deps.notify?.();
  }

  private async persistVoid(tx: OfflineTransaction): Promise<void> {
    const voidSaleId = tx.voidSaleId;
    if (!voidSaleId) return;
    const saleRec = await this.deps.db.get<DTO>('sales', voidSaleId);
    if (!saleRec) throw new Error(`Venta ${voidSaleId} no encontrada para anular offline`);

    const details = await this.deps.db.getByIndex<DTO>('sale_details', 'saleId', voidSaleId);
    for (const d of details) {
      await this.applyStockDelta(String(d['producto_id']), Number(d['cantidad'] ?? 0));
    }

    if (saleRec['metodo_pago'] === 'EFECTIVO' && Number(saleRec['total'] ?? 0) > 0) {
      await this.deps.db.put('cash_movements', {
        id: localId('cashmov'),
        shiftId: String(saleRec['shiftId']),
        tipo: 'DEVOLUCION',
        monto: -Number(saleRec['total']),
        referencia_id: voidSaleId,
        created_at: new Date().toISOString(),
      } as never);
    }

    await this.deps.db.put('sales', { ...saleRec, status: 'VOIDED' } as never);

    // Nota: el server de sync no contempla operación de anulación -> el
    // restock y el REFUND quedan locales; al reconectar se debe anular por
    // la vía online habitual si la venta ya se había sincronizado.
    this.deps.notify?.();
  }

  private async applyStockDelta(productId: string, delta: number): Promise<void> {
    const rows = await this.deps.db.getByIndex<DTO>('stock_sucursal', 'producto_id', productId);
    for (const row of rows) {
      const nuevo = Math.max(0, Number(row['cantidad'] ?? 0) + delta);
      const id = String(row['id'] ?? `${String(row['producto_id'])}:${String(row['sucursal_id'] ?? '')}`);
      await this.deps.db.put('stock_sucursal', { ...row, id, cantidad: nuevo } as never);
    }
  }
}

class OfflineTransaction implements ITransaction {
  sale: SaleData | null = null;
  saleId = '';
  items: CartItem[] = [];
  voidSaleId: string | null = null;
  voidReason: string | undefined;
  receivedBatch: { productId: string; quantity: number } | null = null;

  constructor(
    private readonly deps: OfflineDeps,
    readonly stock: Map<string, number>,
    private readonly localSales: Map<string, SaleRow>
  ) {}

  findOpenShift(shiftId: string): { id: string; status: string } | null {
    if (!this.deps.openShifts.has(shiftId)) return null;
    return { id: shiftId, status: 'OPEN' };
  }

  findSaleById(saleId: string): SaleRow | null {
    return this.localSales.get(saleId) ?? null;
  }

  voidSale(saleId: string, reason?: string): void {
    this.voidSaleId = saleId;
    this.voidReason = reason;
  }

  decrementStock(productId: string, quantity: number): boolean {
    const current = this.stock.get(productId) ?? 0;
    if (current < quantity) return false;
    this.stock.set(productId, current - quantity);
    return true;
  }

  consumeBatchesFefo(_productId: string, _quantity: number): BatchConsumption[] {
    return [];
  }

  incrementStock(productId: string, quantity: number): void {
    this.stock.set(productId, (this.stock.get(productId) ?? 0) + quantity);
  }

  insertBatch(_data: { productId: string; batchCode: string; quantity: number; expirationDate: Date }): string {
    this.receivedBatch = { productId: _data.productId, quantity: _data.quantity };
    return '';
  }

  insertSale(data: SaleData): string {
    this.sale = data;
    this.saleId = localId('sale');
    return this.saleId;
  }

  insertSaleDetails(_saleId: string, items: CartItem[]): void {
    this.items = items;
  }

  insertStockMovement(_m: { productId: string; delta: number; reason: 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN'; referenceId?: string; batchDetail?: BatchConsumption[] }): void {
    return;
  }

  insertCashMovement(_m: CashMovementData): void {
    return;
  }
}

// ─── Productos (catálogo leíble offline tras el primer pull) ─────────────────

export class OfflineProductRepository implements IProductRepository {
  constructor(
    private readonly online: IProductRepository,
    private readonly deps: OfflineDeps
  ) {}

  async findAllActive(): Promise<Product[]> {
    if (this.deps.isOnline()) return this.online.findAllActive();
    const prods = await this.deps.db.getAll<DTO>('productos');
    const stock = await this.deps.db.getAll<DTO>('stock_sucursal');
    return prods
      .filter((p) => Number(p['activo'] ?? 1) !== 0)
      .map((p) => {
        const row = stock.find((s) => String(s['producto_id']) === String(p['id']));
        return mapProduct({ ...p, stock_sucursal: row ? Number(row['cantidad']) : 0 } as DTO);
      });
  }

  async findByBarcode(barcode: string): Promise<Product | null> {
    if (this.deps.isOnline()) return this.online.findByBarcode(barcode);
    const all = await this.findAllActive();
    return all.find((p) => String(p.barcode) === barcode) ?? null;
  }

  async findById(id: string): Promise<Product | null> {
    if (this.deps.isOnline()) return this.online.findById(id);
    const dto = await this.deps.db.get<DTO>('productos', id);
    return dto ? mapProduct(dto as DTO) : null;
  }

  async findAll(): Promise<Product[]> {
    if (this.deps.isOnline()) return this.online.findAll();
    return this.findAllActive();
  }

  async findBySku(sku: string): Promise<Product | null> {
    if (this.deps.isOnline()) return this.online.findBySku(sku);
    const all = await this.findAllActive();
    return all.find((p) => String(p.sku) === sku) ?? null;
  }

  async create(_product: Omit<Product, 'id'>): Promise<Product> {
    if (!this.deps.isOnline()) throw new Error('Gestión de catálogo requiere conexión');
    return this.online.create(_product);
  }

  async update(_id: string, _changes: Partial<Omit<Product, 'id'>>): Promise<Product> {
    if (!this.deps.isOnline()) throw new Error('Gestión de catálogo requiere conexión');
    return this.online.update(_id, _changes);
  }

  async delete(_id: string): Promise<void> {
    if (!this.deps.isOnline()) throw new Error('Gestión de catálogo requiere conexión');
    return this.online.delete(_id);
  }
}