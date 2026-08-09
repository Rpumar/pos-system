/**
 * Verificación del arqueo de caja (cierre de turno):
 *  - el esperado se computa sobre el ledger (ventas efectivo + devoluciones +
 *    depósitos - retiros) de forma idéntica al servidor;
 *  - una venta cobrada y luego anulada NO debe inflar el efectivo esperado;
 *  - la anulación de una venta en efectivo registra un movimiento REFUND negativo;
 *  - un turno cerrado con descuadre (CON_DESCUADRE) se mapea como CERRADO,
 *    nunca como abierto.
 */
import { CloseShiftUseCase } from '../../src/application/use-cases/ShiftUseCases';
import { VoidSaleUseCase } from '../../src/application/use-cases/VoidSaleUseCase';
import { Shift } from '../../src/domain/entities/Shift';
import { CashMovement } from '../../src/domain/entities/CashMovement';
import { IShiftRepository, IAuditLogRepository } from '../../src/application/ports/IAuthRepositories';
import { ITransaction, IUnitOfWork, SaleData } from '../../src/application/ports/IUnitOfWork';

let failures = 0;
function assert(condition: boolean, message: string): void {
  console.log(condition ? `  ✅ ${message}` : `  ❌ ${message}`);
  if (!condition) failures++;
}

function makeRepo(movements: CashMovement[], opening = 500): IShiftRepository {
  return {
    async create() { throw new Error('no usado'); },
    async findById() { return new Shift('SH-1', 'CAJERO-1', 'CAJA-1', opening, 'OPEN', new Date()); },
    async findOpenByRegister() { return null; },
    async addCashMovement() {},
    async close() {},
    async getCashMovements() { return movements; },
    async getCardSalesTotal() { return 0; },
    async getSalesByHour() { return []; },
    async getSalesByMethod() { return []; },
    async getSalesByCashier() { return []; },
    async getShiftHistory() { return []; },
    async getShiftDetail() { return null; },
    async getTopProducts() { return []; },
  };
}

// ── Test 1: ledger correcto tras venta cobrada y anulada ──────────────────────
async function test1_expected_with_refund(): Promise<void> {
  console.log('\nTest 1: el esperado descuenta devoluciones (venta cobrada y anulada)');
  const movements = [
    new CashMovement('m1', 'SH-1', 'SALE_CASH', 160.5),
    new CashMovement('mol2', 'SH-1', 'REFUND', -160.5),
    new CashMovement('m3', 'SH-1', 'DEPOSIT', 1000),
    new CashMovement('m4', 'SH-1', 'WITHDRAWAL', 200, 'pago proveedor', 'sup-1'),
  ];
  const uc = new CloseShiftUseCase(makeRepo(movements));
  const summary = await uc.execute('SH-1', 1300);
  assert(summary.expectedCash === 1300, 'esperado = 500 + 160.5 - 160.5 + 1000 - 200 = 1300');
  assert(Math.abs(summary.difference) < 1e-9, 'diferencia = 0 con arqueo correcto');
  assert(!summary.flagged, 'no se marca descuadre');
  assert(summary.totalRefunds === -160.5, 'el resumen expone las devoluciones');
}

// ── Test 2: arqueo fuera de tolerancia se marca como descuadre ────────────────
async function test2_flagged(): Promise<void> {
  console.log('\nTest 2: arqueo fuera de tolerancia marca descuadre');
  const movements = [new CashMovement('m1', 'SH-1', 'SALE_CASH', 160.5)];
  const uc = new CloseShiftUseCase(makeRepo(movements));
  const summary = await uc.execute('SH-1', 500);
  assert(Math.abs(summary.difference - -160.5) < 1e-9, 'diferencia = contado - esperado');
  assert(summary.flagged, 'se marca descuadre');
}

// ── Test 3: anular venta en efectivo registra REFUND negativo ─────────────────
async function test3_void_registers_refund(): Promise<void> {
  console.log('\nTest 3: anular una venta en efectivo registra REFUND negativo');
  const movements: Array<{ type: string; amount: number }> = [];
  const voided: string[] = [];

  const uow: IUnitOfWork = {
    async execute(work) {
      const tx: ITransaction = {
        findSaleById: () =>
          ({ id: 'S-1', shiftId: 'SH-1', paymentMethod: 'CASH' as const, total: 160.5, details: [{ productId: 'p1', quantity: 1 }] }),
        voidSale(saleId) { voided.push(saleId); },
        incrementStock() {},
        insertStockMovement() {},
        insertCashMovement(o) { movements.push({ type: o.type, amount: o.amount }); },
        findOpenShift() { return null; },
        decrementStock() { return true; },
        consumeBatchesFefo() { return []; },
        insertBatch() { return ''; },
        insertSale(_d: SaleData) { return 's-1'; },
        insertSaleDetails() {},
      };
      return work(tx);
    },
  };

  const noopAudit: IAuditLogRepository = { async record() {} };
  const uc = new VoidSaleUseCase(uow, noopAudit);
  await uc.execute({ saleId: 'S-1', cashierId: 'c-1', reason: 'prueba' });
  assert(voided.length === 1, 'la venta se anuló');
  const refund = movements.find((m) => m.type === 'REFUND');
  assert(!!refund, 'existe movimiento REFUND');
  assert(refund && refund.amount === -160.5, 'el monto del REFUND es negativo e igual a la venta');
}

// ── Test 4: CON_DESCUADRE se interpreta como turno cerrado ────────────────────
async function test4_status_mapping(): Promise<void> {
  console.log('\nTest 4: CON_DESCUADRE se interpreta como turno CERRADO');
  const { mapShiftStatus } = await import('../../src/infrastructure/http/mappers');
  assert(mapShiftStatus('ABIERTO') === 'OPEN', 'ABIERTO => OPEN');
  assert(mapShiftStatus('CERRADO') === 'CLOSED', 'CERRADO => CLOSED');
  assert(mapShiftStatus('CON_DESCUADRE') === 'CLOSED', 'CON_DESCUADRE => CLOSED');
}

console.log('=== Verificación del Módulo: Arqueo de caja (ledger consistente) ===');

(async () => {
  await test1_expected_with_refund();
  await test2_flagged();
  await test3_void_registers_refund();
  await test4_status_mapping();
  console.log(`\n${failures === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${failures} CHECK(S) FALLARON`}`);
  process.exit(failures === 0 ? 0 : 1);
})();