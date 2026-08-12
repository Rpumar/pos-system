import type { AppContainer } from './container';
import { ApiClient } from './infrastructure/http/ApiClient';
import { ServerSessionContext } from './infrastructure/persistence/server/ServerSessionContext';
import { ServerProductRepository } from './infrastructure/persistence/server/ServerProductRepository';
import { ServerShiftRepository } from './infrastructure/persistence/server/ServerShiftRepository';
import { ServerBatchRepository } from './infrastructure/persistence/server/ServerBatchRepository';
import { ServerUserRepository } from './infrastructure/persistence/server/ServerUserRepository';
import { ServerUnitOfWork } from './infrastructure/persistence/server/ServerUnitOfWork';
import { ServerAuthenticateUseCase } from './infrastructure/auth/ServerAuthenticateUseCase';
import { InMemoryProductCache } from './infrastructure/persistence/InMemoryProductCache';
import { PeripheralEventBus } from './infrastructure/hardware/PeripheralEventBus';
import { PrintJobQueue } from './infrastructure/hardware/PrintJobQueue';
import { IPaymentTerminal, IThermalPrinter } from './application/ports/IPeripherals';
import { IpcPrinter } from './infrastructure/hardware/IpcPrinter';
import { AddProductToCartUseCase } from './application/use-cases/AddProductToCartUseCase';
import { CommitSaleUseCase } from './application/use-cases/CommitSaleUseCase';
import { ReceiveBatchUseCase } from './application/use-cases/ReceiveBatchUseCase';
import { GetExpirationAlertsUseCase } from './application/use-cases/GetExpirationAlertsUseCase';
import { ProcessPaymentUseCase, FinalizeSaleUseCase } from './application/use-cases/PaymentUseCases';
import { VoidSaleUseCase } from './application/use-cases/VoidSaleUseCase';
import { RegisterCashMovementUseCase } from './application/use-cases/CashMovementUseCase';
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
import { IAuditLogRepository, IShiftRepository } from './application/ports/IAuthRepositories';
import { IUnitOfWork } from './application/ports/IUnitOfWork';
import { IProductRepository } from './application/ports/IProductRepository';
import {
  OfflineDB,
  createPOSOfflineDB,
  OutboxManager,
  SyncManager,
  NetworkDetector,
  OfflineShiftRepository,
  OfflineUnitOfWork,
  OfflineProductRepository,
  buildOfflineDeps,
} from './infrastructure/persistence/offline';

const silentLogger = {
  warn: (msg: string, meta?: object) => console.warn('[WARN]', msg, meta ?? ''),
  error: (msg: string, meta?: object) => console.error('[ERROR]', msg, meta ?? ''),
};

function createMockTerminal(): IPaymentTerminal {
  return {
    async charge(_amount: number) {
      const authCode = String(Math.floor(100000 + Math.random() * 900000));
      return { status: 'APPROVED', authCode, message: 'Aprobado (terminal simulado)' };
    },
    async reverseCharge() {
      return { status: 'APPROVED', message: 'Reverso ok' };
    },
    async cancelCurrentTransaction() {
      return undefined;
    },
    async isOnline() {
      return true;
    },
  };
}

const noopAuditLog: IAuditLogRepository = {
  record: async () => undefined,
};

const CACHE_STALE_MS = 5 * 60_000;

export interface ServerContainerOptions {
  apiBaseUrl: string;
  registerId?: string;
}

export function buildServerContainer(options: ServerContainerOptions): AppContainer {
  const baseUrl = options.apiBaseUrl.replace(/\/$/, '');
  const api = new ApiClient(`${baseUrl}/api`);
  const ctx = new ServerSessionContext(api);

  const serverProductRepo = new ServerProductRepository(api);
  const serverShiftRepo = new ServerShiftRepository(api, ctx);
  const serverUnitOfWork = new ServerUnitOfWork(api, ctx);

  let productRepo: IProductRepository = serverProductRepo;
  let shiftRepo: IShiftRepository = serverShiftRepo;
  let unitOfWork: IUnitOfWork = serverUnitOfWork;

  // ── Offline-first: adaptadores que enqueuean al outbox cuando NO hay red ──
  let offlineDB: OfflineDB | null = null;
  let outboxManager: OutboxManager | null = null;
  let syncManager: SyncManager | null = null;
  let networkDetector: NetworkDetector | null = null;

  if (typeof window !== 'undefined') {
    offlineDB = createPOSOfflineDB();
    outboxManager = new OutboxManager(offlineDB);
    networkDetector = new NetworkDetector({
      checkUrl: `${baseUrl}/api/health`,
    });
    networkDetector.startPolling();
    syncManager = new SyncManager(offlineDB, outboxManager, {
      apiBaseUrl: `${baseUrl}/api`,
    });

    const deps = buildOfflineDeps(offlineDB, outboxManager, networkDetector);
    deps.resolveLive = async (registerId: string) => {
      if (!deps.isOnline()) return null;
      const r = await ctx.resolveRegister(registerId);
      return { cajaId: r.cajaId, sucursalId: r.sucursalId, cajaNombre: r.cajaNombre };
    };
    deps.onCajaResolved = (cajaId: string) => syncManager?.setCaja(cajaId);

    shiftRepo = new OfflineShiftRepository(serverShiftRepo, deps);
    unitOfWork = new OfflineUnitOfWork(serverUnitOfWork, deps);
    productRepo = new OfflineProductRepository(serverProductRepo, deps);
  }

  const productCache = new InMemoryProductCache(productRepo, CACHE_STALE_MS);
  const batchRepo = new ServerBatchRepository(api);
  const userRepo = new ServerUserRepository();

  const eventBus = new PeripheralEventBus();
  const terminal = createMockTerminal();
  const printer: IThermalPrinter = new IpcPrinter(eventBus);
  const printQueue = new PrintJobQueue(printer, eventBus, silentLogger);

  let syncStarted = false;
  const authenticate = new ServerAuthenticateUseCase(api, ctx, (token: string) => {
    if (!syncManager) return;
    syncManager.setAuth(token);
    if (!syncStarted) {
      syncStarted = true;
      syncManager.start();
    }
  });

  const addProduct = new AddProductToCartUseCase(productCache);
  const commitSale = new CommitSaleUseCase(unitOfWork);
  const processPayment = new ProcessPaymentUseCase(terminal);
  const finalizeSale = new FinalizeSaleUseCase(processPayment, commitSale, printQueue, terminal);
  const voidSaleBase = new VoidSaleUseCase(unitOfWork, noopAuditLog);
  const voidSale = new SupervisorAuthorizationDecorator(voidSaleBase, authenticate, noopAuditLog, 'VOID_SALE');
  const registerCashMovement = new RegisterCashMovementUseCase(shiftRepo);
  const cashDeposit = registerCashMovement;
  const cashWithdrawal = new SupervisorAuthorizationDecorator(registerCashMovement, authenticate, noopAuditLog, 'CASH_WITHDRAWAL');
  const openShift = new OpenShiftUseCase(shiftRepo);
  const closeShift = new CloseShiftUseCase(shiftRepo);
  const receiveBatch = new ReceiveBatchUseCase(unitOfWork);
  const getAlerts = new GetExpirationAlertsUseCase(batchRepo);

  const createProduct = new CreateProductUseCase(productRepo);
  const updateProduct = new UpdateProductUseCase(productRepo);
  const deleteProduct = new DeleteProductUseCase(productRepo);
  const listProducts = new ListProductsUseCase(productRepo);
  const importProducts = new ImportProductsCsvUseCase(productRepo);

  const getXReport = new GetXReportUseCase(shiftRepo);
  const getZReport = new GetZReportUseCase(shiftRepo);
  const getShiftHistory = new GetShiftHistoryUseCase(shiftRepo);
  const getShiftDetail = new GetShiftDetailUseCase(shiftRepo);

  const registerId = options.registerId ?? 'CAJA-1';

  return {
    useCases: {
      addProduct,
      finalizeSale,
      voidSale,
      cashDeposit,
      cashWithdrawal,
      openShift,
      closeShift,
      authenticate,
      receiveBatch,
      getAlerts,
      createProduct,
      updateProduct,
      deleteProduct,
      listProducts,
      importProducts,
      getXReport,
      getZReport,
      getShiftHistory,
      getShiftDetail,
    },
    eventBus,
    productCache,
    config: { registerId },
    offline: { offlineDB, outboxManager, syncManager, networkDetector },
    hardware: { printer, terminal, scanner: null },
  } as unknown as AppContainer;
}
