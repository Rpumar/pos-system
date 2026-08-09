import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config';
import { createDatabaseConnection, initializeSchema } from './infrastructure/persistence/sqlite/Database';
import { SqliteUnitOfWork } from './infrastructure/persistence/sqlite/SqliteUnitOfWork';
import { SqliteProductRepository } from './infrastructure/persistence/sqlite/SqliteProductRepository';
import { SqliteBatchRepository } from './infrastructure/persistence/sqlite/SqliteBatchRepository';
import { SqliteUserRepository, SqliteShiftRepository, SqliteAuditLogRepository } from './infrastructure/persistence/sqlite/SqliteAuthRepositories';
import { InMemoryProductCache } from './infrastructure/persistence/InMemoryProductCache';
import { PeripheralEventBus } from './infrastructure/hardware/PeripheralEventBus';
import { PaymentTerminalFactory } from './infrastructure/hardware/PaymentTerminalFactory';
import { PrintJobQueue } from './infrastructure/hardware/PrintJobQueue';
import { SerialPortPrinter, PrinterFactory } from './infrastructure/hardware/SerialPortPrinter';
import { USBBarcodeScanner, ScannerFactory } from './infrastructure/hardware/USBBarcodeScanner';
import { Sha256PinHasher } from './infrastructure/security/Sha256PinHasher';
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
  CreateProductUseCase,
  UpdateProductUseCase,
  DeleteProductUseCase,
  ListProductsUseCase,
  ImportProductsCsvUseCase,
} from './application/use-cases/ProductManagementUseCases';
import {
  GetXReportUseCase,
  GetZReportUseCase,
  GetShiftHistoryUseCase,
  GetShiftDetailUseCase,
} from './application/use-cases/ReportUseCases';
import { IThermalPrinter } from './application/ports/IPeripherals';
import { OfflineDB, createPOSOfflineDB } from './infrastructure/persistence/offline/OfflineDB';
import { OutboxManager } from './infrastructure/persistence/offline/OutboxManager';
import { SyncManager } from './infrastructure/persistence/offline/SyncManager';
import { NetworkDetector } from './infrastructure/persistence/offline/NetworkDetector';

const silentLogger = {
  warn: (msg: string, meta?: object) => console.warn('[WARN]', msg, meta ?? ''),
  error: (msg: string, meta?: object) => console.error('[ERROR]', msg, meta ?? ''),
};

function createPrinter(): IThermalPrinter {
  const { vendor, portPath, baudRate } = config.printer;

  if (vendor === 'MOCK') {
    return {
      async getStatus() { return 'READY' as const; },
      async print(c: string) { console.log('[PRINTER]', c); },
      async openCashDrawer() { console.log('[PRINTER] Cajón abierto'); },
    };
  }

  try {
    return PrinterFactory.create({ vendor, portPath, baudRate });
  } catch (error) {
    silentLogger.error('Error creando impresora real, usando mock', { error: error instanceof Error ? error.message : 'unknown' });
    return {
      async getStatus() { return 'ERROR' as const; },
      async print(c: string) { console.log('[PRINTER]', c); },
      async openCashDrawer() { console.log('[PRINTER] Cajón abierto'); },
    };
  }
}

function createScanner() {
  const { type, vendorId, productId } = config.scanner;

  if (type === 'NONE') return null;

  try {
    const { scanner, type: actualType } = ScannerFactory.create({
      type,
      vendorId: vendorId || undefined,
      productId: productId || undefined,
    });
    return { scanner, type: actualType };
  } catch (error) {
    silentLogger.error('Error creando scanner, usando HID_KEYBOARD fallback', { error: error instanceof Error ? error.message : 'unknown' });
    const { ScannerDetector } = require('./presentation/services/ScannerDetector');
    return {
      scanner: new ScannerDetector(30, 6),
      type: 'HID_KEYBOARD',
    };
  }
}

export function buildContainer() {
  mkdirSync(dirname(config.db.path), { recursive: true });
  const db = createDatabaseConnection(config.db.path);
  initializeSchema(db);

  const unitOfWork   = new SqliteUnitOfWork(db);
  const productRepo  = new SqliteProductRepository(db);
  const productCache = new InMemoryProductCache(productRepo, config.cache.staleAfterMs);
  const batchRepo    = new SqliteBatchRepository(db);
  const userRepo     = new SqliteUserRepository(db);
  const shiftRepo    = new SqliteShiftRepository(db);
  const auditLog     = new SqliteAuditLogRepository(db);

  const eventBus   = new PeripheralEventBus();
  const terminal   = PaymentTerminalFactory.create(config.terminal, eventBus);
  const printer    = createPrinter();
  const scanner    = createScanner();

  const printQueue = new PrintJobQueue(printer, eventBus, silentLogger);

  // Configurar scanner USB HID si está disponible
  if (scanner && scanner.type === 'USB_HID') {
    (scanner.scanner as any).on('scan', (barcode: string) => {
      eventBus.emit('scanner:scan', { barcode, type: 'USB_HID' });
    });
    (scanner.scanner as any).on('open', () => {
      eventBus.emit('scanner:connected', { type: 'USB_HID' });
    });
    (scanner.scanner as any).on('close', () => {
      eventBus.emit('scanner:disconnected', { type: 'USB_HID' });
    });
    scanner.scanner.open().catch((err: Error) => {
      silentLogger.error('Error abriendo scanner USB', { error: err.message });
    });
  }

  // Offline-first components (solo en browser)
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

  const hasher       = new Sha256PinHasher();
  const authenticate = new AuthenticateCashierUseCase(userRepo, hasher, auditLog);

  const addProduct     = new AddProductToCartUseCase(productCache);
  const commitSale     = new CommitSaleUseCase(unitOfWork);
  const processPayment = new ProcessPaymentUseCase(terminal);
  const finalizeSale   = new FinalizeSaleUseCase(processPayment, commitSale, printQueue, terminal);
  const voidSaleBase   = new VoidSaleUseCase(unitOfWork, auditLog);
  const voidSale       = new SupervisorAuthorizationDecorator(voidSaleBase, authenticate, auditLog, 'VOID_SALE');
  const registerCashMovement = new RegisterCashMovementUseCase(shiftRepo);
  const cashDeposit    = registerCashMovement;
  const cashWithdrawal = new SupervisorAuthorizationDecorator(registerCashMovement, authenticate, auditLog, 'CASH_WITHDRAWAL');
  const openShift      = new OpenShiftUseCase(shiftRepo);
  const closeShift     = new CloseShiftUseCase(shiftRepo);
  const receiveBatch   = new ReceiveBatchUseCase(unitOfWork);
  const getAlerts      = new GetExpirationAlertsUseCase(batchRepo);

  const createProduct  = new CreateProductUseCase(productRepo);
  const updateProduct  = new UpdateProductUseCase(productRepo);
  const deleteProduct  = new DeleteProductUseCase(productRepo);
  const listProducts   = new ListProductsUseCase(productRepo);
  const importProducts = new ImportProductsCsvUseCase(productRepo);

  const getXReport = new GetXReportUseCase(shiftRepo);
  const getZReport = new GetZReportUseCase(shiftRepo);
  const getShiftHistory = new GetShiftHistoryUseCase(shiftRepo);
  const getShiftDetail = new GetShiftDetailUseCase(shiftRepo);

  return {
    useCases: {
      addProduct, finalizeSale, voidSale, cashDeposit, cashWithdrawal, openShift, closeShift, authenticate, receiveBatch, getAlerts,
      createProduct, updateProduct, deleteProduct, listProducts, importProducts,
      getXReport, getZReport, getShiftHistory, getShiftDetail,
    },
    eventBus,
    productCache,
    config: { registerId: config.register.id },
    // Offline-first
    offline: { offlineDB, outboxManager, syncManager, networkDetector },
    // Hardware
    hardware: { printer, terminal, scanner: scanner?.scanner },
  };
}

export type AppContainer = ReturnType<typeof buildContainer>;