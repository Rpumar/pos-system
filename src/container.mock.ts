import { Product } from './domain/entities/Product';
import { Batch } from './domain/entities/Batch';
import { User } from './domain/entities/User';
import { Shift } from './domain/entities/Shift';
import { CashMovement } from './domain/entities/CashMovement';
import { CartItem } from './domain/entities/Cart';
import { IProductRepository } from './application/ports/IProductRepository';
import { IBatchRepository, ExpirationAlert, classifyUrgency } from './application/ports/IBatchRepository';
import {
  IUserRepository,
  IShiftRepository,
  IAuditLogRepository,
  IPasswordHasher,
  AuditLogData,
  SalesByHour,
  SalesByMethod,
  SalesByCashier,
  ShiftSummary,
} from './application/ports/IAuthRepositories';
import {
  IUnitOfWork,
  ITransaction,
  SaleData,
  StockMovementData,
  CashMovementData,
  BatchConsumption,
  SaleRow,
} from './application/ports/IUnitOfWork';
import { IThermalPrinter, PrinterStatus } from './application/ports/IPeripherals';
import { InsufficientBatchCoverageError } from './application/errors/StockErrors';
import { OfflineDB, createPOSOfflineDB } from './infrastructure/persistence/offline/OfflineDB';
import { OutboxManager } from './infrastructure/persistence/offline/OutboxManager';
import { SyncManager } from './infrastructure/persistence/offline/SyncManager';
import { NetworkDetector } from './infrastructure/persistence/offline/NetworkDetector';
import { AddProductToCartUseCase } from './application/use-cases/AddProductToCartUseCase';
import { CommitSaleUseCase } from './application/use-cases/CommitSaleUseCase';
import { ReceiveBatchUseCase } from './application/use-cases/ReceiveBatchUseCase';
import { GetExpirationAlertsUseCase } from './application/use-cases/GetExpirationAlertsUseCase';
import { ProcessPaymentUseCase, FinalizeSaleUseCase } from './application/use-cases/PaymentUseCases';
import { VoidSaleUseCase } from './application/use-cases/VoidSaleUseCase';
import { RegisterCashMovementUseCase } from './application/use-cases/CashMovementUseCase';
import { AuthenticateCashierUseCase } from './application/use-cases/AuthenticateCashierUseCase';
import { OpenShiftUseCase, CloseShiftUseCase } from './application/use-cases/ShiftUseCases';
import { SupervisorAuthorizationDecorator } from './application/use-cases/SupervisorAuthorizationDecorator';
import {
  GetXReportUseCase,
  GetZReportUseCase,
  GetShiftHistoryUseCase,
  GetShiftDetailUseCase,
} from './application/use-cases/ReportUseCases';
import { InMemoryProductCache } from './infrastructure/persistence/InMemoryProductCache';
import { PeripheralEventBus } from './infrastructure/hardware/PeripheralEventBus';
import { PrintJobQueue } from './infrastructure/hardware/PrintJobQueue';
import { MockPaymentTerminal } from './infrastructure/hardware/MockPaymentTerminal';
import { CircuitBreakerPaymentTerminal } from './infrastructure/hardware/CircuitBreakerPaymentTerminal';
import {
  CreateProductUseCase,
  UpdateProductUseCase,
  DeleteProductUseCase,
  ListProductsUseCase,
  ImportProductsCsvUseCase,
} from './application/use-cases/ProductManagementUseCases';
import type { AppContainer } from './container';

interface SaleRecord {
  id: string;
  shiftId: string;
  cashierId: string;
  total: number;
  method: 'CASH' | 'CARD';
  authCode?: string;
  status: 'PAID' | 'VOIDED';
  details: Array<{ productId: string; quantity: number; unitPrice: number; subtotal: number }>;
}

class MockDatabase {
  readonly products = new Map<string, Product>();
  readonly batches: Batch[] = [];
  readonly users = new Map<string, User>();
  readonly shifts = new Map<string, Shift>();
  readonly sales = new Map<string, SaleRecord>();
  readonly cashMovements: CashMovement[] = [];
  readonly stockMovements: StockMovementData[] = [];
  readonly auditEntries: AuditLogData[] = [];
  private sequence = 0;

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

type Undo = () => void;

class MockTransaction implements ITransaction {
  constructor(private readonly store: MockDatabase, private readonly undo: Undo[]) {}

  findSaleById(saleId: string): SaleRow | null {
    const sale = this.store.sales.get(saleId);
    if (!sale || sale.status !== 'PAID') return null;
    return {
      id: sale.id,
      details: sale.details.map((detail) => ({ productId: detail.productId, quantity: detail.quantity })),
    };
  }

  voidSale(saleId: string): void {
    const sale = this.store.sales.get(saleId);
    if (!sale || sale.status === 'VOIDED') return;
    const previous = sale.status;
    this.undo.push(() => {
      sale.status = previous;
    });
    sale.status = 'VOIDED';
  }

  findOpenShift(shiftId: string): { id: string; status: string } | null {
    const shift = this.store.shifts.get(shiftId);
    return shift && shift.status === 'OPEN' ? { id: shift.id, status: shift.status } : null;
  }

  decrementStock(productId: string, quantity: number): boolean {
    const product = this.store.products.get(productId);
    if (!product || product.stock < quantity) return false;
    const previous = product.stock;
    this.undo.push(() => {
      product.stock = previous;
    });
    product.stock -= quantity;
    return true;
  }

  incrementStock(productId: string, quantity: number): void {
    const product = this.store.products.get(productId);
    if (!product) return;
    const previous = product.stock;
    this.undo.push(() => {
      product.stock = previous;
    });
    product.stock += quantity;
  }

  consumeBatchesFefo(productId: string, quantity: number): BatchConsumption[] {
    const candidates = this.store.batches
      .filter((batch) => batch.productId === productId && batch.quantity > 0)
      .sort((a, b) => a.expirationDate.getTime() - b.expirationDate.getTime());

    const consumptions: BatchConsumption[] = [];
    let remaining = quantity;

    for (const batch of candidates) {
      if (remaining <= 0) break;
      const taken = Math.min(batch.quantity, remaining);
      const previous = batch.quantity;
      this.undo.push(() => {
        batch.quantity = previous;
      });
      batch.quantity -= taken;
      consumptions.push({ batchId: batch.id, batchCode: batch.batchCode, quantityTaken: taken });
      remaining -= taken;
    }

    if (remaining > 0) {
      throw new InsufficientBatchCoverageError(productId, quantity, quantity - remaining);
    }

    return consumptions;
  }

  insertBatch(data: { productId: string; batchCode: string; quantity: number; expirationDate: Date }): string {
    const id = this.store.nextId('BATCH');
    const batch = new Batch(id, data.productId, data.batchCode, data.quantity, data.expirationDate);
    this.undo.push(() => {
      const index = this.store.batches.indexOf(batch);
      if (index >= 0) this.store.batches.splice(index, 1);
    });
    this.store.batches.push(batch);
    return id;
  }

  insertSale(data: SaleData): string {
    const id = this.store.nextId('SALE');
    const record: SaleRecord = {
      id,
      shiftId: data.shiftId,
      cashierId: data.cashierId,
      total: data.total,
      method: data.method,
      authCode: data.authCode,
      status: data.status,
      details: [],
    };
    this.undo.push(() => {
      this.store.sales.delete(id);
    });
    this.store.sales.set(id, record);
    return id;
  }

  insertSaleDetails(saleId: string, items: CartItem[]): void {
    const record = this.store.sales.get(saleId);
    if (!record) return;
    const previous = record.details;
    this.undo.push(() => {
      record.details = previous;
    });
    record.details = items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
    }));
  }

  insertStockMovement(movement: StockMovementData): void {
    this.undo.push(() => {
      const index = this.store.stockMovements.indexOf(movement);
      if (index >= 0) this.store.stockMovements.splice(index, 1);
    });
    this.store.stockMovements.push(movement);
  }

  insertCashMovement(movement: CashMovementData): void {
    const id = this.store.nextId('MOV');
    const entry = new CashMovement(id, movement.shiftId, movement.type, movement.amount, undefined, undefined, movement.referenceId);
    this.undo.push(() => {
      const index = this.store.cashMovements.indexOf(entry);
      if (index >= 0) this.store.cashMovements.splice(index, 1);
    });
    this.store.cashMovements.push(entry);
  }
}

class MockUnitOfWork implements IUnitOfWork {
  constructor(private readonly store: MockDatabase) {}

  async execute<T>(work: (tx: ITransaction) => T): Promise<T> {
    const undo: Undo[] = [];
    const transaction = new MockTransaction(this.store, undo);
    try {
      const result = work(transaction);
      undo.length = 0;
      return result;
    } catch (error) {
      for (let index = undo.length - 1; index >= 0; index -= 1) {
        undo[index]!();
      }
      throw error;
    }
  }
}

class MockProductRepository implements IProductRepository {
  constructor(private readonly store: MockDatabase) {}

  async findByBarcode(barcode: string): Promise<Product | null> {
    for (const product of this.store.products.values()) {
      if (product.barcode === barcode) return product;
    }
    return null;
  }

  async findAllActive(): Promise<Product[]> {
    return Array.from(this.store.products.values()).filter((product) => product.active);
  }

  async findById(id: string): Promise<Product | null> {
    return this.store.products.get(id) ?? null;
  }

  async findAll(): Promise<Product[]> {
    return Array.from(this.store.products.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async findBySku(sku: string): Promise<Product | null> {
    for (const product of this.store.products.values()) {
      if (product.sku === sku) return product;
    }
    return null;
  }

  async create(product: Omit<Product, 'id'>): Promise<Product> {
    const id = this.store.nextId('P');
    const newProduct = new Product(id, product.sku, product.barcode, product.name, product.price, product.stock, product.active);
    this.store.products.set(id, newProduct);
    return newProduct;
  }

  async update(id: string, changes: Partial<Omit<Product, 'id'>>): Promise<Product> {
    const existing = this.store.products.get(id);
    if (!existing) throw new Error('Producto no encontrado');

    const updated = new Product(
      id,
      changes.sku ?? existing.sku,
      changes.barcode ?? existing.barcode,
      changes.name ?? existing.name,
      changes.price ?? existing.price,
      changes.stock ?? existing.stock,
      changes.active ?? existing.active
    );
    this.store.products.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.store.products.delete(id);
  }
}

class MockBatchRepository implements IBatchRepository {
  constructor(private readonly store: MockDatabase) {}

  async findExpiringWithin(days: number): Promise<ExpirationAlert[]> {
    const reference = new Date();
    const alerts: ExpirationAlert[] = [];

    for (const batch of this.store.batches) {
      if (batch.quantity <= 0) continue;
      const daysUntilExpiration = batch.daysUntilExpiration(reference);
      if (daysUntilExpiration > days) continue;

      const product = this.store.products.get(batch.productId);
      alerts.push({
        batchId: batch.id,
        productId: batch.productId,
        productName: product?.name ?? 'Producto desconocido',
        sku: product?.sku ?? batch.productId,
        batchCode: batch.batchCode,
        quantity: batch.quantity,
        expirationDate: batch.expirationDate,
        daysUntilExpiration,
        urgency: classifyUrgency(daysUntilExpiration),
      });
    }

    return alerts;
  }
}

class MockUserRepository implements IUserRepository {
  constructor(private readonly store: MockDatabase) {}

  async findById(id: string): Promise<User | null> {
    return this.store.users.get(id) ?? null;
  }

  async findAll(): Promise<User[]> {
    return Array.from(this.store.users.values());
  }
}

class MockShiftRepository implements IShiftRepository {
  constructor(private readonly store: MockDatabase) {}

  async create(data: { cashierId: string; registerId: string; openingAmount: number }): Promise<Shift> {
    const id = this.store.nextId('SHIFT');
    const shift = new Shift(id, data.cashierId, data.registerId, data.openingAmount, 'OPEN', new Date());
    this.store.shifts.set(id, shift);
    return shift;
  }

  async findById(id: string): Promise<Shift | null> {
    return this.store.shifts.get(id) ?? null;
  }

  async findOpenByRegister(registerId: string): Promise<Shift | null> {
    for (const shift of this.store.shifts.values()) {
      if (shift.registerId === registerId && shift.status === 'OPEN') return shift;
    }
    return null;
  }

  async close(id: string, data: { expectedCash: number; countedCash: number; difference: number }): Promise<void> {
    const shift = this.store.shifts.get(id);
    if (!shift) return;
    shift.status = 'CLOSED';
    shift.expectedCash = data.expectedCash;
    shift.countedCash = data.countedCash;
    shift.difference = data.difference;
    shift.closedAt = new Date();
  }

  async getCashMovements(shiftId: string): Promise<CashMovement[]> {
    return this.store.cashMovements.filter((movement) => movement.shiftId === shiftId);
  }

  async addCashMovement(
    shiftId: string,
    data: { type: 'WITHDRAWAL' | 'DEPOSIT'; amount: number; reason?: string; authorizedBy?: string }
  ): Promise<void> {
    this.store.cashMovements.push(
      new CashMovement(
        this.store.nextId('MOV'),
        shiftId,
        data.type,
        data.amount,
        data.reason,
        data.authorizedBy
      )
    );
  }

  async getCardSalesTotal(shiftId: string): Promise<number> {
    let total = 0;
    for (const sale of this.store.sales.values()) {
      if (sale.shiftId === shiftId && sale.method === 'CARD' && sale.status === 'PAID') {
        total += sale.total;
      }
    }
    return total;
  }

  // ── Report queries ──────────────────────────────────────────────────────────

  async getSalesByHour(shiftId: string): Promise<SalesByHour[]> {
    const hourMap = new Map<number, { count: number; total: number; cashTotal: number; cardTotal: number }>();

    for (const sale of this.store.sales.values()) {
      if (sale.shiftId !== shiftId || sale.status !== 'PAID') continue;
      const hour = new Date(sale.createdAt).getHours();
      const existing = hourMap.get(hour) ?? { count: 0, total: 0, cashTotal: 0, cardTotal: 0 };
      existing.count++;
      existing.total += sale.total;
      if (sale.method === 'CASH') existing.cashTotal += sale.total;
      else existing.cardTotal += sale.total;
      hourMap.set(hour, existing);
    }

    const result: SalesByHour[] = [];
    for (const [hour, data] of hourMap.entries()) {
      result.push({ hour, ...data });
    }
    return result.sort((a, b) => a.hour - b.hour);
  }

  async getSalesByMethod(shiftId: string): Promise<SalesByMethod[]> {
    const cash = { count: 0, total: 0 };
    const card = { count: 0, total: 0 };

    for (const sale of this.store.sales.values()) {
      if (sale.shiftId !== shiftId || sale.status !== 'PAID') continue;
      if (sale.method === 'CASH') { cash.count++; cash.total += sale.total; }
      else { card.count++; card.total += sale.total; }
    }

    const result: SalesByMethod[] = [];
    if (cash.count > 0) result.push({ method: 'CASH', ...cash });
    if (card.count > 0) result.push({ method: 'CARD', ...card });
    return result;
  }

  async getSalesByCashier(shiftId: string): Promise<SalesByCashier[]> {
    const cashierMap = new Map<string, { cashierId: string; cashierName: string; count: number; total: number; cashTotal: number; cardTotal: number }>();

    for (const sale of this.store.sales.values()) {
      if (sale.shiftId !== shiftId || sale.status !== 'PAID') continue;
      const cashier = this.store.users.get(sale.cashierId);
      const name = cashier?.name ?? 'Desconocido';
      const existing = cashierMap.get(sale.cashierId) ?? { cashierId: sale.cashierId, cashierName: name, count: 0, total: 0, cashTotal: 0, cardTotal: 0 };
      existing.count++;
      existing.total += sale.total;
      if (sale.method === 'CASH') existing.cashTotal += sale.total;
      else existing.cardTotal += sale.total;
      cashierMap.set(sale.cashierId, existing);
    }

    return Array.from(cashierMap.values()).sort((a, b) => b.total - a.total);
  }

  async getShiftHistory(registerId?: string, limit = 50): Promise<ShiftSummary[]> {
    const shifts = Array.from(this.store.shifts.values())
      .filter(s => !registerId || s.registerId === registerId)
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
      .slice(0, limit);

    return shifts.map(shift => {
      const sales = Array.from(this.store.sales.values()).filter(s => s.shiftId === shift.id && s.status === 'PAID');
      const totalSales = sales.reduce((sum, s) => sum + s.total, 0);
      const totalCashSales = sales.filter(s => s.method === 'CASH').reduce((sum, s) => sum + s.total, 0);
      const totalCardSales = sales.filter(s => s.method === 'CARD').reduce((sum, s) => sum + s.total, 0);
      const cashier = this.store.users.get(shift.cashierId);

      return {
        id: shift.id,
        cashierId: shift.cashierId,
        cashierName: cashier?.name ?? 'Desconocido',
        registerId: shift.registerId,
        openingAmount: shift.openingAmount,
        expectedCash: shift.expectedCash ?? null,
        countedCash: shift.countedCash ?? null,
        difference: shift.difference ?? null,
        status: shift.status,
        openedAt: shift.openedAt,
        closedAt: shift.closedAt ?? null,
        totalSales,
        totalCashSales,
        totalCardSales,
        saleCount: sales.length,
      };
    });
  }

  async getShiftDetail(shiftId: string): Promise<ShiftSummary | null> {
    const shift = this.store.shifts.get(shiftId);
    if (!shift) return null;

    const sales = Array.from(this.store.sales.values()).filter(s => s.shiftId === shiftId && s.status === 'PAID');
    const totalSales = sales.reduce((sum, s) => sum + s.total, 0);
    const totalCashSales = sales.filter(s => s.method === 'CASH').reduce((sum, s) => sum + s.total, 0);
    const totalCardSales = sales.filter(s => s.method === 'CARD').reduce((sum, s) => sum + s.total, 0);
    const cashier = this.store.users.get(shift.cashierId);

    return {
      id: shift.id,
      cashierId: shift.cashierId,
      cashierName: cashier?.name ?? 'Desconocido',
      registerId: shift.registerId,
      openingAmount: shift.openingAmount,
      expectedCash: shift.expectedCash ?? null,
      countedCash: shift.countedCash ?? null,
      difference: shift.difference ?? null,
      status: shift.status,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt ?? null,
      totalSales,
      totalCashSales,
      totalCardSales,
      saleCount: sales.length,
    };
  }

  async getTopProducts(shiftId: string, limit = 10): Promise<Array<{ productId: string; sku: string; name: string; quantity: number; total: number }>> {
    const productMap = new Map<string, { productId: string; sku: string; name: string; quantity: number; total: number }>();

    for (const sale of this.store.sales.values()) {
      if (sale.shiftId !== shiftId || sale.status !== 'PAID') continue;
      for (const detail of sale.details) {
        const product = this.store.products.get(detail.productId);
        const existing = productMap.get(detail.productId) ?? {
          productId: detail.productId,
          sku: product?.sku ?? detail.productId,
          name: product?.name ?? 'Desconocido',
          quantity: 0,
          total: 0,
        };
        existing.quantity += detail.quantity;
        existing.total += detail.subtotal;
        productMap.set(detail.productId, existing);
      }
    }

    return Array.from(productMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, limit);
  }
}

class MockAuditLogRepository implements IAuditLogRepository {
  constructor(private readonly store: MockDatabase) {}

  async record(entry: AuditLogData): Promise<void> {
    this.store.auditEntries.push(entry);
    console.log(
      `[AUDIT] ${entry.userId} · ${entry.action}` +
        `${entry.entity ? ` · ${entry.entity}:${entry.entityId ?? '-'}` : ''}`
    );
  }
}

class MockPinHasher implements IPasswordHasher {
  private static format(pin: string): string {
    return `dev:${pin}`;
  }

  async hash(plain: string): Promise<string> {
    return MockPinHasher.format(plain);
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    return stored === MockPinHasher.format(plain);
  }
}

class ConsoleThermalPrinter implements IThermalPrinter {
  async getStatus(): Promise<PrinterStatus> {
    return 'READY';
  }

  async print(content: string): Promise<void> {
    console.log(`[PRINTER]\n${content}`);
  }

  async openCashDrawer(): Promise<void> {
    console.log('[PRINTER] Cajón de dinero abierto');
  }
}

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function seedStore(): MockDatabase {
  const store = new MockDatabase();

  const coca = new Product('P-1', 'COCA-500', '7790001', 'Coca Cola 500ml', 150, 100);
  const agua = new Product('P-2', 'AGUA-1L', '7790002', 'Agua Mineral 1L', 80, 50);
  const arroz = new Product('P-3', 'ARROZ-1K', '7790003', 'Arroz 1kg', 120, 30);
  const leche = new Product('P-4', 'LECHE-1L', '7790004', 'Leche Entera 1L', 90, 20);
  const pan = new Product('P-5', 'PAN-500', '7790005', 'Pan de Sándwich 500g', 60, 0);

  store.products.set(coca.id, coca);
  store.products.set(agua.id, agua);
  store.products.set(arroz.id, arroz);
  store.products.set(leche.id, leche);
  store.products.set(pan.id, pan);

  store.batches.push(
    new Batch('B-1', coca.id, 'COCA-A', 40, daysFromNow(30)),
    new Batch('B-2', coca.id, 'COCA-B', 60, daysFromNow(90)),
    new Batch('B-3', agua.id, 'AGUA-A', 50, daysFromNow(45)),
    new Batch('B-4', arroz.id, 'ARROZ-A', 30, daysFromNow(5)),
    new Batch('B-5', leche.id, 'LECHE-A', 20, daysFromNow(-2))
  );

  store.users.set('1', new User('1', 'Ana Cajera', 'dev:1234', 'CASHIER'));
  store.users.set('2', new User('2', 'Pedro Supervisor', 'dev:9999', 'SUPERVISOR'));

  return store;
}

export interface MockContainerOptions {
  registerId?: string;
  cacheStaleAfterMs?: number;
  terminalLatencyMs?: number;
}

export function buildMockContainer(options: MockContainerOptions = {}): AppContainer {
  const store = seedStore();
  const registerId = options.registerId ?? 'CAJA-1';

  const productRepository = new MockProductRepository(store);
  const productCache = new InMemoryProductCache(productRepository, options.cacheStaleAfterMs ?? 5 * 60_000);

  const unitOfWork = new MockUnitOfWork(store);
  const batchRepository = new MockBatchRepository(store);
  const userRepository = new MockUserRepository(store);
  const shiftRepository = new MockShiftRepository(store);
  const auditLog = new MockAuditLogRepository(store);

  const eventBus = new PeripheralEventBus();
  const terminal = new CircuitBreakerPaymentTerminal(
    new MockPaymentTerminal('APPROVE', options.terminalLatencyMs ?? 1500),
    eventBus
  );

  const printer = new ConsoleThermalPrinter();
  const printQueue = new PrintJobQueue(printer, eventBus, {
    warn: (message: string) => console.warn('[PRINTER]', message),
    error: (message: string) => console.error('[PRINTER]', message),
  });

  // Offline-first components (mock for browser)
  let offlineDB: OfflineDB | null = null;
  let outboxManager: OutboxManager | null = null;
  let syncManager: SyncManager | null = null;
  let networkDetector: NetworkDetector | null = null;

  if (typeof window !== 'undefined') {
    offlineDB = createPOSOfflineDB();
    outboxManager = new OutboxManager(offlineDB);
    syncManager = new SyncManager(offlineDB, outboxManager, {
      apiBaseUrl: config.apiBaseUrl ?? '/api',
    });
    networkDetector = new NetworkDetector({
      checkUrl: `${config.apiBaseUrl ?? '/api'}/health`,
    });
    networkDetector.startPolling();
    syncManager.start();
  }

  const hasher = new MockPinHasher();
  const authenticate = new AuthenticateCashierUseCase(userRepository, hasher, auditLog);

  const addProduct = new AddProductToCartUseCase(productCache);
  const commitSale = new CommitSaleUseCase(unitOfWork);
  const processPayment = new ProcessPaymentUseCase(terminal);
  const finalizeSale = new FinalizeSaleUseCase(processPayment, commitSale, printQueue, terminal);
  const voidSaleBase = new VoidSaleUseCase(unitOfWork, auditLog);
  const voidSale = new SupervisorAuthorizationDecorator(voidSaleBase, authenticate, auditLog, 'VOID_SALE');
  const registerCashMovement = new RegisterCashMovementUseCase(shiftRepository);
  const cashDeposit = registerCashMovement;
  const cashWithdrawal = new SupervisorAuthorizationDecorator(registerCashMovement, authenticate, auditLog, 'CASH_WITHDRAWAL');
  const openShift = new OpenShiftUseCase(shiftRepository);
  const closeShift = new CloseShiftUseCase(shiftRepository);
  const receiveBatch = new ReceiveBatchUseCase(unitOfWork);
  const getAlerts = new GetExpirationAlertsUseCase(batchRepository);

  const createProduct = new CreateProductUseCase(productRepository);
  const updateProduct = new UpdateProductUseCase(productRepository);
  const deleteProduct = new DeleteProductUseCase(productRepository);
  const listProducts = new ListProductsUseCase(productRepository);
  const importProducts = new ImportProductsCsvUseCase(productRepository);

  const getXReport = new GetXReportUseCase(shiftRepository);
  const getZReport = new GetZReportUseCase(shiftRepository);
  const getShiftHistory = new GetShiftHistoryUseCase(shiftRepository);
  const getShiftDetail = new GetShiftDetailUseCase(shiftRepository);

  return {
    useCases: {
      addProduct, finalizeSale, voidSale, cashDeposit, cashWithdrawal, openShift, closeShift, authenticate, receiveBatch, getAlerts,
      createProduct, updateProduct, deleteProduct, listProducts, importProducts,
      getXReport, getZReport, getShiftHistory, getShiftDetail,
    },
    eventBus,
    productCache,
    config: { registerId },
    offline: { offlineDB, outboxManager, syncManager, networkDetector },
    hardware: { printer, terminal, scanner: null },
  };
}
