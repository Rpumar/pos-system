/**
 * Verificación del movimiento de efectivo en caja (retiro/depósito).
 * Usa mocks puros: cubre el uso directo (depósito) y la exigencia
 * de autorización de supervisor (retiro) vía decorador.
 */
import { RegisterCashMovementUseCase } from '../../src/application/use-cases/CashMovementUseCase';
import { SupervisorAuthorizationDecorator } from '../../src/application/use-cases/SupervisorAuthorizationDecorator';
import { AuthenticateCashierUseCase } from '../../src/application/use-cases/AuthenticateCashierUseCase';
import { Sha256PinHasher } from '../../src/infrastructure/security/Sha256PinHasher';
import { User } from '../../src/domain/entities/User';
import { CashMovement } from '../../src/domain/entities/CashMovement';
import { IShiftRepository, IAuditLogRepository, IUserRepository } from '../../src/application/ports/IAuthRepositories';
import { UnauthorizedActionError } from '../../src/application/errors/AuthErrors';

let failures = 0;
function assert(condition: boolean, message: string): void {
  console.log(condition ? `  ✅ ${message}` : `  ❌ ${message}`);
  if (!condition) failures++;
}

const hasher = new Sha256PinHasher();

function makeShiftRepo(): IShiftRepository & { movements: CashMovement[] } {
  const movements: CashMovement[] = [];
  return {
    movements,
    async create(data) {
      throw new Error('no usado');
    },
    async findById() { return null; },
    async findOpenByRegister() { return null; },
    async addCashMovement(shiftId, data) {
      movements.push(new CashMovement(
        `MOV-${movements.length + 1}`, shiftId, data.type, data.amount, data.reason, data.authorizedBy
      ));
    },
    async close() {},
    async getCashMovements() { return movements; },
    async getCardSalesTotal() { return 0; },
  };
}

const noopAudit: IAuditLogRepository = { async record() {} };
const captureAudit = (): IAuditLogRepository & { entries: string[] } => {
  const entries: string[] = [];
  return { entries, async record(e) { entries.push(e.action); } };
};

async function makeUserRepo(users: User[]): Promise<IUserRepository> {
  return {
    async findById(id) { return users.find((u) => u.id === id) ?? null; },
    async findAll() { return users; },
  };
}

async function test1_deposit(): Promise<void> {
  console.log('\nTest 1: depósito sin autorización');
  const repo = makeShiftRepo();
  const uc = new RegisterCashMovementUseCase(repo);
  await uc.execute({ shiftId: 'S-1', type: 'DEPOSIT', amount: 1500, reason: 'cambio inicial' });
  assert(repo.movements.length === 1, 'se registró el depósito');
  assert(repo.movements[0].type === 'DEPOSIT' && repo.movements[0].amount === 1500, 'monto y tipo correctos');
  assert(repo.movements[0].authorizedBy === undefined, 'depósito no requiere autorización');
}

async function test2_amountValidation(): Promise<void> {
  console.log('\nTest 2: validación de monto');
  const repo = makeShiftRepo();
  const uc = new RegisterCashMovementUseCase(repo);
  let caught: unknown;
  try { await uc.execute({ shiftId: 'S-1', type: 'DEPOSIT', amount: 0 }); } catch (e) { caught = e; }
  assert(caught instanceof Error && repo.movements.length === 0, 'monto <= 0 es rechazado');
}

async function test3_withdrawalAuthorization(): Promise<void> {
  console.log('\nTest 3: retiro exige supervisor');
  const supervisorHash = await hasher.hash('9999');
  const cashierHash = await hasher.hash('1111');
  const supervisor = new User('sup-1', 'Laura Ruiz', supervisorHash, 'SUPERVISOR', true);
  const cashier = new User('cas-1', 'Pedro López', cashierHash, 'CASHIER', true);
  const userRepo = await makeUserRepo([supervisor, cashier]);
  const audit = captureAudit();
  const authenticate = new AuthenticateCashierUseCase(userRepo, hasher, audit);
  const repo = makeShiftRepo();

  const base = new RegisterCashMovementUseCase(repo);
  const withdrawal = new SupervisorAuthorizationDecorator(base, authenticate, audit, 'CASH_WITHDRAWAL');

  // Cajero intenta autorizar → rechazado
  let caught: unknown;
  try {
    await withdrawal.execute(
      { shiftId: 'S-1', type: 'WITHDRAWAL', amount: 200, reason: 'pago proveedor' },
      'cas-1', '1111', 'cas-1'
    );
  } catch (e) { caught = e; }
  assert(caught instanceof UnauthorizedActionError, 'cajero no puede autorizar un retiro');
  assert(repo.movements.length === 0, 'el retiro no se registró');

  // Supervisor autoriza correctamente
  await withdrawal.execute(
    { shiftId: 'S-1', type: 'WITHDRAWAL', amount: 200, reason: 'pago proveedor', authorizedBy: 'sup-1' },
    'sup-1', '9999', 'cas-1'
  );
  assert(repo.movements.length === 1, 'el retiro se registró con autorización');
  assert(repo.movements[0].type === 'WITHDRAWAL' && repo.movements[0].amount === 200, 'tipo y monto correctos');
  assert(repo.movements[0].authorizedBy === 'sup-1', 'queda registrado quién autorizó');
  assert(audit.entries.includes('CASH_WITHDRAWAL'), 'CASH_WITHDRAWAL queda en auditoría');
}

console.log('=== Verificación del Módulo: Movimiento de efectivo (retiro/depósito) ===');

(async () => {
  await test1_deposit();
  await test2_amountValidation();
  await test3_withdrawalAuthorization();
  console.log(`\n${failures === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${failures} CHECK(S) FALLARON`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
