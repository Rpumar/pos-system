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
import { IAuditLogRepository } from './application/ports/IAuthRepositories';

const silentLogger = {
  warn: (msg: string, meta?: object) => console.warn('[WARN]', msg, meta ?? ''),
  error: (msg: string, meta?: object) => console.error('[ERROR]', msg, meta ?? ''),
};

function createMockPrinter(): IThermalPrinter {
  return {
    async getStatus() {
      return 'READY' as const;
    },
    async print(c: string) {
      console.log('[PRINTER]', c);
    },
    async openCashDrawer() {
      console.log('[PRINTER] Cajón abierto');
    },
  };
}

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

  const productRepo = new ServerProductRepository(api);
  const productCache = new InMemoryProductCache(productRepo, CACHE_STALE_MS);
  const batchRepo = new ServerBatchRepository(api);
  const shiftRepo = new ServerShiftRepository(api, ctx);
  const unitOfWork = new ServerUnitOfWork(api, ctx);
  const userRepo = new ServerUserRepository();

  const eventBus = new PeripheralEventBus();
  const terminal = createMockTerminal();
  const printer = createMockPrinter();
  const printQueue = new PrintJobQueue(printer, eventBus, silentLogger);

  const authenticate = new ServerAuthenticateUseCase(api, ctx);

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
    offline: { offlineDB: null, outboxManager: null, syncManager: null, networkDetector: null },
    hardware: { printer, terminal, scanner: null },
  } as unknown as AppContainer;
}
