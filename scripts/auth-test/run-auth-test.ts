/**
 * Verificación del Paso 5 usando mocks puros (sin SQLite).
 * La lógica de autenticación, bloqueo, arqueo y autorización
 * es independiente del motor de base de datos.
 */
import { AuthenticateCashierUseCase } from '../../src/application/use-cases/AuthenticateCashierUseCase';
import { OpenShiftUseCase, CloseShiftUseCase } from '../../src/application/use-cases/ShiftUseCases';
import { SupervisorAuthorizationDecorator, ISensitiveAction } from '../../src/application/use-cases/SupervisorAuthorizationDecorator';
import { Sha256PinHasher } from '../../src/infrastructure/security/Sha256PinHasher';
import { User } from '../../src/domain/entities/User';
import { Shift } from '../../src/domain/entities/Shift';
import { CashMovement } from '../../src/domain/entities/CashMovement';
import { IUserRepository, IShiftRepository, IAuditLogRepository } from '../../src/application/ports/IAuthRepositories';
import { InvalidPinError, AccountLockedError, ShiftAlreadyOpenError, ShiftNotOpenError, UnauthorizedActionError } from '../../src/application/errors/AuthErrors';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(condition: boolean, message: string): void {
  console.log(condition ? `  ✅ ${message}` : `  ❌ ${message}`);
  if (!condition) failures++;
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const hasher = new Sha256PinHasher();

async function makeUserRepo(users: User[]): Promise<IUserRepository> {
  return {
    async findById(id) { return users.find((u) => u.id === id) ?? null; },
    async findAll() { return users; },
  };
}

const noopAudit: IAuditLogRepository = { async record() {} };
const captureAudit = (): IAuditLogRepository & { entries: string[] } => {
  const entries: string[] = [];
  return { entries, async record(e) { entries.push(e.action); } };
};

function makeShiftRepo(): IShiftRepository & { shifts: Shift[] } {
  const shifts: Shift[] = [];
  const movements: CashMovement[] = [];
  return {
    shifts,
    async create(data) {
      const s = new Shift(String(shifts.length + 1), data.cashierId, data.registerId, data.openingAmount, 'OPEN', new Date());
      shifts.push(s);
      return s;
    },
    async findById(id) { return shifts.find((s) => s.id === id) ?? null; },
    async findOpenByRegister(rid) { return shifts.find((s) => s.registerId === rid && s.isOpen()) ?? null; },
    async close(id, data) {
      const s = shifts.find((s) => s.id === id);
      if (s) { s.status = 'CLOSED'; s.expectedCash = data.expectedCash; s.countedCash = data.countedCash; s.difference = data.difference; }
    },
    async addCashMovement(shiftId, data) {
      movements.push(new CashMovement(String(movements.length + 1), shiftId, data.type, data.amount, data.reason, data.authorizedBy));
    },
    async getCashMovements() { return movements; },
    async getCardSalesTotal() { return 0; },
  };
}

// ── Test 1: autenticación por PIN ─────────────────────────────────────────────

async function test1_pinAuth(): Promise<void> {
  console.log('\nTest 1: autenticación por PIN');
  const pinHash = await hasher.hash('1234');
  const cashier = new User('1', 'Ana García', pinHash, 'CASHIER', true);
  const repo = await makeUserRepo([cashier]);
  const audit = captureAudit();
  const uc = new AuthenticateCashierUseCase(repo, hasher, audit);

  const result = await uc.execute('1', '1234');
  assert(result.id === '1', `login exitoso devuelve el usuario correcto (fue: ${result.id})`);
  assert(audit.entries.includes('LOGIN_SUCCESS'), 'LOGIN_SUCCESS queda en auditoría');

  let caught: unknown;
  try { await uc.execute('1', '9999'); } catch (e) { caught = e; }
  assert(caught instanceof InvalidPinError, 'PIN incorrecto lanza InvalidPinError');
  assert(audit.entries.includes('LOGIN_FAILED'), 'LOGIN_FAILED queda en auditoría');
}

// ── Test 2: bloqueo por intentos fallidos ─────────────────────────────────────

async function test2_lockout(): Promise<void> {
  console.log('\nTest 2: bloqueo tras 3 intentos fallidos');
  const pinHash = await hasher.hash('5678');
  const user = new User('2', 'Carlos Pérez', pinHash, 'CASHIER', true);
  const repo = await makeUserRepo([user]);
  const uc = new AuthenticateCashierUseCase(repo, hasher, noopAudit, 3, 500);

  for (let i = 0; i < 3; i++) {
    try { await uc.execute('2', 'WRONG'); } catch {}
  }

  let caught: unknown;
  try { await uc.execute('2', '5678'); } catch (e) { caught = e; } // PIN correcto pero cuenta bloqueada
  assert(caught instanceof AccountLockedError, `cuenta bloqueada tras 3 fallos (fue: ${caught?.constructor?.name})`);

  await delay(520); // esperar que expire el lockout (500ms)
  const recovered = await uc.execute('2', '5678');
  assert(recovered.id === '2', 'login exitoso tras expirar el bloqueo');
}

// ── Test 3: apertura y cierre de turno ───────────────────────────────────────

async function test3_shift(): Promise<void> {
  console.log('\nTest 3: apertura y cierre de turno (arqueo)');
  const repo = makeShiftRepo();
  const openUC = new OpenShiftUseCase(repo);
  const closeUC = new CloseShiftUseCase(repo);

  const shift = await openUC.execute('cashier-1', 'CAJA-1', 500);
  assert(shift.isOpen(), 'el turno queda abierto');

  let caught: unknown;
  try { await openUC.execute('cashier-2', 'CAJA-1', 500); } catch (e) { caught = e; }
  assert(caught instanceof ShiftAlreadyOpenError, 'no se puede abrir un segundo turno en la misma caja');

  // Cierre con el cajón exactamente como debería estar (sin ventas en este mock, solo el monto de apertura)
  const summary = await closeUC.execute(shift.id, 500);
  assert(summary.expectedCash === 500, `expectedCash correcto (fue: ${summary.expectedCash})`);
  assert(summary.difference === 0, `diferencia cero (fue: ${summary.difference})`);
  assert(!summary.flagged, 'no se marcó como descuadre');

  let caught2: unknown;
  try { await closeUC.execute(shift.id, 500); } catch (e) { caught2 = e; }
  assert(caught2 instanceof ShiftNotOpenError, 'no se puede cerrar un turno ya cerrado');
}

// ── Test 4: decorador de supervisor ──────────────────────────────────────────

async function test4_supervisorDecorator(): Promise<void> {
  console.log('\nTest 4: SupervisorAuthorizationDecorator');
  const supervisorHash = await hasher.hash('9999');
  const cashierHash    = await hasher.hash('1111');
  const supervisor = new User('sup-1', 'Laura Ruiz', supervisorHash, 'SUPERVISOR', true);
  const cashier    = new User('cas-1', 'Pedro López', cashierHash, 'CASHIER', true);
  const repo = await makeUserRepo([supervisor, cashier]);
  const audit = captureAudit();
  const authenticate = new AuthenticateCashierUseCase(repo, hasher, audit);

  let actionExecuted = false;
  const sensitiveAction: ISensitiveAction<string, string> = {
    async execute(input) { actionExecuted = true; return `done:${input}`; },
  };

  const decorated = new SupervisorAuthorizationDecorator(sensitiveAction, authenticate, audit, 'VOID_SALE');

  // Éxito: supervisor con PIN correcto
  actionExecuted = false;
  const result = await decorated.execute('input-1', 'sup-1', '9999', 'cas-1');
  assert(result === 'done:input-1', `la acción se ejecutó y devolvió el resultado correcto (fue: ${result})`);
  assert(actionExecuted, 'la acción sensible fue ejecutada');
  assert(audit.entries.includes('VOID_SALE'), 'VOID_SALE queda registrado en auditoría');

  // Fallo: cajero intenta autorizar (no tiene el rol)
  let caught: unknown;
  try { await decorated.execute('input-2', 'cas-1', '1111', 'cas-1'); } catch (e) { caught = e; }
  assert(caught instanceof UnauthorizedActionError, `cajero no puede autorizar acciones sensibles (fue: ${caught?.constructor?.name})`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

console.log('=== Verificación del Paso 5: Seguridad, Login y Cierre de Caja ===');

(async () => {
  await test1_pinAuth();
  await test2_lockout();
  await test3_shift();
  await test4_supervisorDecorator();
  console.log(`\n${failures === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${failures} CHECK(S) FALLARON`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
