import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OutboxManager } from '../../src/infrastructure/persistence/offline/OutboxManager';
import { SyncManager } from '../../src/infrastructure/persistence/offline/SyncManager';

// El pipeline offline del cliente depende de IndexedDB (browser). Para validar el
// camino completo en Node usamos un fake de OfflineDB con la MISMA interfaz que
// consume OutboxManager/SyncManager (put/get/getAll/getByIndex/delete/getPendingSync).
class FakeOfflineDB {
  private stores = new Map<string, any[]>();

  constructor() {
    this.stores.set('outbox', []);
    this.stores.set('conflicts', []);
    this.stores.set('meta', []);
    this.stores.set('productos', []);
    this.stores.set('stock_sucursal', []);
    this.stores.set('lotes', []);
    this.stores.set('usuarios', []);
  }

  async put(storeName: string, record: any): Promise<void> {
    if (!this.stores.has(storeName)) this.stores.set(storeName, []);
    const list = this.stores.get(storeName)!;
    const idx = list.findIndex((r) => r.id === record.id);
    const rec = { ...record, updatedAt: Date.now() };
    if (idx === -1) list.push(rec);
    else list[idx] = rec;
  }

  async get<T>(storeName: string, id: string): Promise<T | undefined> {
    return this.stores.get(storeName)?.find((r) => r.id === id) as T | undefined;
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    return [...(this.stores.get(storeName) ?? [])] as T[];
  }

  async getByIndex<T>(storeName: string, _index: string, value: any): Promise<T[]> {
    return (this.stores.get(storeName) ?? []).filter((r) => (r as any)[_index] === value) as T[];
  }

  async delete(storeName: string, id: string): Promise<void> {
    const list = this.stores.get(storeName);
    if (list) this.stores.set(storeName, list.filter((r) => r.id !== id));
  }

  // Mismo contrato que OfflineDB.getPendingSync: syncedAt undefined/0 => pendiente
  async getPendingSync(storeName: string, limit = 100): Promise<any[]> {
    const list = this.stores.get(storeName) ?? [];
    return list
      .filter((r) => r.syncedAt === undefined || r.syncedAt <= 0)
      .slice(0, limit);
  }
}

let fails = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' -> ' + extra : ''));
  if (!ok) fails++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

  const SERVER_DIR = join(process.cwd(), 'server');
  const dir = mkdtempSync(join(tmpdir(), 'pos-offline-'));
  const dbPath = join(dir, 'test.db');
  const PORT = 4106;
  const API = `http://localhost:${PORT}/api`;

  const server = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), POS_SERVER_DB_PATH: dbPath },
    stdio: 'ignore',
  });

  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(API + '/health'); break; } catch { await sleep(400); }
    }

    const login = await (await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@pos.com', pin: '1234' }),
    })).json();
    const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
    const caja = await (await fetch(API + '/mi/caja?nombre=CAJA-1', { headers: H })).json();
    const sup = await (await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'supervisor@pos.com', pin: '9999' }),
    })).json();
    const prods = await (await fetch(API + '/productos?search=Leche', { headers: H })).json();
    const leche = prods[0];
    const totalLeche = Math.round((leche.precio + leche.precio * leche.impuesto) * 100) / 100;

    // ── Escenario offline: turno, venta efectivo, depósito, retiro autorizado, cierre ──
    const shiftId = crypto.randomUUID();
    const saleId = crypto.randomUUID();
    const depId = crypto.randomUUID();
    const retId = crypto.randomUUID();
    const badRetId = crypto.randomUUID();
    const now = new Date().toISOString();

    const ops = [
      { type: 'CREATE_SHIFT', payload: { id: shiftId, caja_id: caja.caja_id, sucursal_id: caja.sucursal_id, usuario_id: login.user.id, monto_apertura: 500, opened_at: now } },
      { type: 'CREATE_SALE', payload: { id: saleId, turno_id: shiftId, caja_id: caja.caja_id, sucursal_id: caja.sucursal_id, usuario_id: login.user.id, metodo_pago: 'EFECTIVO', codigo_autorizacion: null, detalles: [{ producto_id: leche.id, cantidad: 1, precio_unitario: 999, impuesto: 0 }], total: 999, subtotal: 999, impuestos: 0, created_at: now } },
      { type: 'CREATE_CASH_MOVEMENT', payload: { id: depId, turno_id: shiftId, tipo: 'DEPOSITO', monto: 200, motivo: 'cambio', created_at: now } },
      { type: 'CREATE_CASH_MOVEMENT', payload: { id: retId, turno_id: shiftId, tipo: 'RETIRO', monto: 100, motivo: 'cajon comun', autorizado_por: sup.user.id, created_at: now } },
      // Operación ilegítima en medio: retiro SIN autorización — debe fallar en el server y quedar fuera del ledger
      { type: 'CREATE_CASH_MOVEMENT', payload: { id: badRetId, turno_id: shiftId, tipo: 'RETIRO', monto: 50, motivo: 'intento no autorizado', created_at: now } },
      { type: 'CLOSE_SHIFT', payload: { id: shiftId, monto_contado: 675.625, monto_esperado: 999999, diferencia: -999, flagged: true } },
    ];

    const db = new FakeOfflineDB();
    const outbox = new OutboxManager(db as any);
    const sync = new SyncManager(db as any, outbox, {
      apiBaseUrl: API,
      cajaId: caja.caja_id,
      authToken: login.token,
      conflictStrategy: 'server-wins',
    });

    for (const op of ops) await outbox.enqueue(op.type as any, op.payload);

    const result = await sync.sync();

    // 31 = 26 rows del pull (10 productos + 10 stock + 6 usuarios) + 5 ops de outbox ok.
    // La 6ta op (retiro sin autorización) falla y queda pendiente.
    check('sync: legitimas procesadas + una rechazada',
      result.synced === 31 && result.failed === 1 && result.errors.length === 1,
      `synced=${result.synced} failed=${result.failed} err=${JSON.stringify(result.errors)}`);

    const pendientes = await outbox.getPending();
    check('sync: la op rechazada queda pendiente con error de autorizacion',
      pendientes.length === 1 && pendientes[0].type === 'CREATE_CASH_MOVEMENT' && pendientes[0].payload.id === badRetId && /autoriza/i.test(pendientes[0].lastError ?? ''),
      `pendientes=${pendientes.length} tipo=${pendientes[0]?.type} lastError=${pendientes[0]?.lastError}`);

    // ── Verificación contra el server (estado real) ──
    // esperado recalculado por el server: apertura 500 + venta (subtotal+impuestos) + deposito 200 - retiro 100.
    // El impuesto de la Leche en el catálogo es 0 => total = 62.5.
    const esperadoReal = 500 + totalLeche + 200 - 100;
    const turno = await (await fetch(API + '/turnos/' + shiftId, { headers: H })).json();
    check('offline: cierre recalcula esperado server-side (fake 999999 ignorado)',
      turno.monto_esperado === esperadoReal,
      `esperado=${turno.monto_esperado} esperadoReal=${esperadoReal}`);
    check('offline: contado fabricado se respeta y el turno queda CON_DESCUADRE',
      turno.monto_contado === 675.625 && turno.estado === 'CON_DESCUADRE',
      `contado=${turno.monto_contado} estado=${turno.estado}`);

    const venta = await (await fetch(API + '/ventas/' + saleId, { headers: H })).json();
    check('offline: venta con precio del maestro (fabricado ignorado)',
      Math.abs(venta.total - totalLeche) < 0.01,
      `total=${venta.total} esperado=${totalLeche}`);

    const movs = (turno.movimientos ?? []) as Array<{ tipo: string; monto: number; autorizado_por?: string | null }>;
    const tipos = movs.map((m) => m.tipo).sort();
    check('offline: ledger con apertura+venta+deposito+retiro+cierre',
      ['APERTURA', 'CIERRE', 'DEPOSITO', 'RETIRO', 'VENTA_EFECTIVO'].every((t) => tipos.includes(t)),
      'tipos=' + tipos.join(','));
    check('offline: el retiro NO autorizado (50) no aparece en el ledger',
      !movs.some((m) => m.tipo === 'RETIRO' && m.monto === 50), '');

    const retiroLegit = movs.find((m) => m.tipo === 'RETIRO' && m.monto === 100);
    check('offline: retiro legitimo quedó con autorizacion de supervisor',
      !!retiroLegit?.autorizado_por, 'autorizado_por=' + retiroLegit?.autorizado_por);

    // Pull con token de cajero (debe devolver catálogo/stock/usuarios)
    const cajeroLogin = await (await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cajero1@pos.com', pin: '1234' }),
    })).json();
    const CH = { Authorization: 'Bearer ' + cajeroLogin.token, 'Content-Type': 'application/json' };
    const pull = await (await fetch(API + '/sync/pull?caja_id=' + caja.caja_id + '&since=0', { headers: CH })).json();
    check('offline: pull devuelve catalogo/stock/usuarios',
      Array.isArray(pull.productos) && Array.isArray(pull.stock) && Array.isArray(pull.usuarios) && pull.productos.length > 0,
      `productos=${pull.productos?.length} stock=${pull.stock?.length} usuarios=${pull.usuarios?.length}`);
  } catch (e) {
    console.log('EXCEPCION: ' + (e instanceof Error ? e.message : String(e)));
    fails++;
  } finally {
    server.kill();
    setTimeout(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
      process.exit(fails > 0 ? 1 : 0);
    }, 700);
  }
})();