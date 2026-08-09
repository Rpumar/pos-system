/**
 * Tests del Paso 4. Verifican sin hardware real:
 *  1. Circuit Breaker: se abre tras N fallos, bloquea sin tocar el hardware, se resetea con éxito.
 *  2. PrintJobQueue: encola y retorna inmediato, reintenta con backoff, descarta tras maxRetries.
 *  3. FinalizeSaleUseCase: reversa automática si el commit falla después de un cobro aprobado.
 */
import { CircuitBreakerPaymentTerminal } from '../../src/infrastructure/hardware/CircuitBreakerPaymentTerminal';
import { MockPaymentTerminal } from '../../src/infrastructure/hardware/MockPaymentTerminal';
import { PeripheralEventBus } from '../../src/infrastructure/hardware/PeripheralEventBus';
import { PrintJobQueue } from '../../src/infrastructure/hardware/PrintJobQueue';
import { IThermalPrinter, PrinterStatus } from '../../src/application/ports/IPeripherals';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(condition: boolean, message: string): void {
  console.log(condition ? `  ✅ ${message}` : `  ❌ ${message}`);
  if (!condition) failures++;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrinterMock(behavior: 'ready' | 'out-of-paper' | 'fail-print'): IThermalPrinter & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    async getStatus(): Promise<PrinterStatus> {
      return behavior === 'out-of-paper' ? 'OUT_OF_PAPER' : 'READY';
    },
    async print(content: string): Promise<void> {
      if (behavior === 'fail-print') throw new Error('Error de escritura en puerto');
      printed.push(content);
    },
    async openCashDrawer(): Promise<void> {},
  };
}

const silentLogger = {
  warn: () => {},
  error: () => {},
};

// ── Test 1: Circuit Breaker ───────────────────────────────────────────────────

async function test1_circuitBreaker(): Promise<void> {
  console.log('\nTest 1: Circuit Breaker abre tras 3 fallos y bloquea sin tocar el terminal');
  const mock = new MockPaymentTerminal('TIMEOUT', 0);
  const bus = new PeripheralEventBus();
  const cb = new CircuitBreakerPaymentTerminal(mock, bus, 3, 500);

  let circuitOpenFired = false;
  bus.on('terminal:circuit-open', () => { circuitOpenFired = true; });

  // 3 fallos → debe abrir el circuito
  await cb.charge(100);
  await cb.charge(100);
  await cb.charge(100);

  assert(cb.isOpen, 'el circuito está abierto tras 3 timeouts');
  assert(circuitOpenFired, 'se emitió el evento terminal:circuit-open');
  assert(cb.failures === 3, `contador en 3 (es: ${cb.failures})`);

  // Intento 4: debe retornar DISCONNECTED SIN llamar al terminal
  mock.setBehavior('APPROVE'); // si lo llamara, devolvería APPROVED
  const blocked = await cb.charge(100);
  assert(blocked.status === 'DISCONNECTED', 'retorna DISCONNECTED sin tocar el terminal');

  // Esperar que el cooldown expire (500ms) y volver a funcionar
  await delay(520);
  mock.setBehavior('APPROVE');
  let reconnectedFired = false;
  bus.on('terminal:reconnected', () => { reconnectedFired = true; });
  const recovered = await cb.charge(100);
  assert(recovered.status === 'APPROVED', `el circuito se recuperó (fue: ${recovered.status})`);
  assert(reconnectedFired, 'se emitió terminal:reconnected al recuperarse');
  assert(cb.failures === 0, 'el contador de fallos se resetea tras éxito');
}

// ── Test 2: PrintJobQueue ─────────────────────────────────────────────────────

async function test2_printJobQueue(): Promise<void> {
  console.log('\nTest 2: PrintJobQueue encola, imprime en background y reintenta ante fallos');
  const bus = new PeripheralEventBus();

  // 2a: impresión exitosa
  const readyPrinter = makePrinterMock('ready');
  const queue = new PrintJobQueue(readyPrinter, bus, silentLogger, { maxRetries: 3, retryDelayMs: 50 });
  queue.enqueue({ id: '1', saleId: 'SALE-1', content: 'TICKET-1' });
  await delay(100);
  assert(readyPrinter.printed.includes('TICKET-1'), 'el ticket se imprimió en background');
  assert(queue.getPendingCount() === 0, 'la cola quedó vacía');

  // 2b: impresora sin papel → emite evento y reintenta
  const failPrinter = makePrinterMock('fail-print');
  let jobFailedFired = false;
  const queue2 = new PrintJobQueue(failPrinter, bus, silentLogger, { maxRetries: 2, retryDelayMs: 50 });
  bus.on('printer:job-failed', () => { jobFailedFired = true; });
  queue2.enqueue({ id: '2', saleId: 'SALE-2', content: 'TICKET-2' });
  await delay(500); // 2 reintentos × 50ms de backoff
  assert(jobFailedFired, 'se emitió printer:job-failed tras agotar los reintentos');
  assert(queue2.getPendingCount() === 0, 'el trabajo se descartó tras maxRetries');

  // 2c: enqueue retorna inmediato aunque la impresión tarde
  const slowPrinter: IThermalPrinter & { printed: string[] } = {
    printed: [],
    async getStatus() { return 'READY' as PrinterStatus; },
    async print(c: string) { await delay(300); slowPrinter.printed.push(c); },
    async openCashDrawer() {},
  };
  const queue3 = new PrintJobQueue(slowPrinter, bus, silentLogger);
  const start = Date.now();
  queue3.enqueue({ id: '3', saleId: 'SALE-3', content: 'TICKET-3' });
  const elapsed = Date.now() - start;
  assert(elapsed < 50, `enqueue retornó en ${elapsed}ms (no bloqueó esperando la impresión)`);
  await delay(400); // esperamos que efectivamente imprima
  assert(slowPrinter.printed.includes('TICKET-3'), 'el ticket sí se imprimió en segundo plano');
}

// ── Test 3: reversa automática en FinalizeSaleUseCase ────────────────────────

async function test3_autoReversal(): Promise<void> {
  console.log('\nTest 3: reversa automática si el commit falla tras un cobro aprobado');

  // Importamos dinámicamente para no arrastrar las dependencias de SQLite
  const { FinalizeSaleUseCase, ProcessPaymentUseCase } = await import('../../src/application/use-cases/PaymentUseCases');
  const { Cart, CartItem } = await import('../../src/domain/entities/Cart');
  const { StockConflictError } = await import('../../src/application/errors/StockErrors');

  const terminal = new MockPaymentTerminal('APPROVE', 0);
  const processPayment = new ProcessPaymentUseCase(terminal);
  const bus = new PeripheralEventBus();
  const printer = makePrinterMock('ready');
  const queue = new PrintJobQueue(printer, bus, silentLogger, { retryDelayMs: 0 });

  let reverseCalled = false;
  const originalReverse = terminal.reverseCharge.bind(terminal);
  terminal.reverseCharge = async (authCode, amount) => {
    reverseCalled = true;
    return originalReverse(authCode, amount);
  };

  // CommitSaleUseCase falso que siempre lanza StockConflictError
  const failingCommit = {
    execute: async () => { throw new StockConflictError('COCA-500', 1); }
  } as never;

  const finalize = new FinalizeSaleUseCase(processPayment, failingCommit, queue, terminal);

  const cart = new Cart();
  cart.addItem(new CartItem('1', 'COCA-500', 'Coca Cola', 100, 1));

  const result = await finalize.execute(cart, 'shift-1', 'user-1', 'CARD');
  assert(!result.success, 'la venta falló correctamente');
  assert(result.success === false && result.reversed, 'el cobro fue revertido automáticamente');
  assert(reverseCalled, 'terminal.reverseCharge() fue llamado');
}

// ── Runner ────────────────────────────────────────────────────────────────────

console.log('=== Verificación del Paso 4: POS Asíncrono e Impresora en Cola ===');

(async () => {
  await test1_circuitBreaker();
  await test2_printJobQueue();
  await test3_autoReversal();
  console.log(`\n${failures === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${failures} CHECK(S) FALLARON`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
