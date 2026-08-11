import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Cart, CartItem } from '../../src/domain/entities/Cart';
import { CommitSaleUseCase } from '../../src/application/use-cases/CommitSaleUseCase';
import { ApiClient } from '../../src/infrastructure/http/ApiClient';
import { ServerSessionContext } from '../../src/infrastructure/persistence/server/ServerSessionContext';
import { ServerShiftRepository } from '../../src/infrastructure/persistence/server/ServerShiftRepository';
import { ServerUnitOfWork } from '../../src/infrastructure/persistence/server/ServerUnitOfWork';
import { ServerProductRepository } from '../../src/infrastructure/persistence/server/ServerProductRepository';
import { OutboxManager } from '../../src/infrastructure/persistence/offline/OutboxManager';
import { SyncManager } from '../../src/infrastructure/persistence/offline/SyncManager';
import {
  OfflineShiftRepository,
  OfflineUnitOfWork,
  buildOfflineDeps,
} from '../../src/infrastructure/persistence/offline/OfflineRepoAdapter';

// Fake OfflineDB con la misma interfaz que consume OutboxManager/SyncManager/
// adaptadores offline (put/get/getAll/getByIndex/delete/getPendingSync).
class FakeOfflineDB {
  private stores = new Map<string, any[]>();

  constructor(names: string[]) {
    for (const n of names) this.stores.set(n, []);
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

  async getByIndex<T>(storeName: string, indexName: string, value: any): Promise<T[]> {
    return (this.stores.get(storeName) ?? []).filter((r) => (r as any)[indexName] === value) as T[];
  }

  async delete(storeName: string, id: string): Promise<void> {
    const list = this.stores.get(storeName);
    if (list) this.stores.set(storeName, list.filter((r) => r.id !== id));
  }

  async getPendingSync(storeName: string, limit = 100): Promise<any[]> {
    const list = this.stores.get(storeName) ?? [];
    return list.filter((r) => r.syncedAt === undefined || r.syncedAt <= 0).slice(0, limit);
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
  const dir = mkdtempSync(join(tmpdir(), 'pos-offline-repo-'));
  const dbPath = join(dir, 'test.db');
  const PORT = 4107;
  const API = `http://localhost:${PORT}/api`;

  const server = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), POS_SERVER_DB_PATH: dbPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stdout.write('[SVR] ' + d.toString()));

  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(API + '/health'); break; } catch { await sleep(400); }
    }

    const login = await (await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@pos.com', pin: '1234' }),
    })).json();
    const token = login.token;
    const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const caja = await (await fetch(API + '/mi/caja?nombre=CAJA-1', { headers: H })).json();
    const sup = await (await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'supervisor@pos.com', pin: '9999' }),
    })).json();
    const prods = await (await fetch(API + '/productos?search=Leche', { headers: H })).json();
    const leche = prods[0];
    const totalLeche = Math.round((leche.precio + leche.precio * (leche.impuesto ?? 0)) * 100) / 100;
    const adminId = login.user.id;
    const supId = sup.user.id;

    // ── Infra offline forzada ──
    const db = new FakeOfflineDB(['outbox', 'conflicts', 'meta', 'sales', 'sale_details',
      'cash_movements', 'shifts', 'productos', 'stock_sucursal', 'lotes', 'usuarios']) as any;
    const outbox = new OutboxManager(db);
    const deps = buildOfflineDeps(db, outbox, null);
    let offlineMode = true;
    (deps as any).isOnline = () => !offlineMode;

    // Seed del catálogo + caja (lo que deja un pull previo mientras había red)
    await db.put('productos', { ...leche, activo: 1 });
    await db.put('stock_sucursal', { id: 'st-' + leche.id, producto_id: leche.id, sucursal_id: caja.sucursal_id, cantidad: 50 });
    await db.put('meta', { id: 'register:CAJA-1', value: { cajaId: caja.caja_id, sucursalId: caja.sucursal_id, cajaNombre: caja.caja_nombre } });

    const api = new ApiClient(API);
    api.setToken(token);
    const ctx = new ServerSessionContext(api);

    const onlineShift = new ServerShiftRepository(api, ctx);
    const onlineUow = new ServerUnitOfWork(api, ctx);
    const onlineProducts = new ServerProductRepository(api);

    const shiftRepo = new OfflineShiftRepository(onlineShift, deps);
    const unitOfWork = new OfflineUnitOfWork(onlineUow, deps);
    const _productRepo = onlineProducts; // lecturas offline cubiertas por OfflineProductRepository (no usado en el flujo de caja)

    // 1. Apertura de turno OFFLINE
    const shift = await shiftRepo.create({ cashierId: adminId, registerId: 'CAJA-1', openingAmount: 500 });
    check('offline: apertura local + enqueue CREATE_SHIFT',
      shift.isOpen() && (await outbox.getPending()).some((o) => o.type === 'CREATE_SHIFT'),
      `shift=${shift.id}`);

    // 2. Venta OFFLINE (CommitSale por el UoW offline)
    const commit = new CommitSaleUseCase(unitOfWork);
    const cart = new Cart();
    cart.addItem(new CartItem(leche.id, leche.sku, leche.nombre, leche.precio, 1));
    const sale = await commit.execute(cart, shift.id, adminId, 'CASH');
    const pending = await outbox.getPending();
    check('offline: venta local + enqueue CREATE_SALE',
      sale.total === totalLeche && pending.some((o) => o.type === 'CREATE_SALE' && o.payload.id === sale.id),
      `sale=${sale.id} total=${sale.total}`);

    // 3. Depósito + retiro OFFLINE
    await shiftRepo.addCashMovement(shift.id, { type: 'DEPOSIT', amount: 200 });
    await shiftRepo.addCashMovement(shift.id, { type: 'WITHDRAWAL', amount: 100, authorizedBy: supId });
    const movs = await shiftRepo.getCashMovements(shift.id);
    check('offline: ledger local con venta+deposito+retiro',
      movs.some((m) => m.type === 'SALE_CASH' && m.amount === totalLeche)
      && movs.some((m) => m.type === 'DEPOSIT' && m.amount === 200)
      && movs.some((m) => m.type === 'WITHDRAWAL' && m.amount === 100),
      `movs=${movs.map((m) => `${m.type}:${m.amount}`).join(',')}`);

    // 4. Cierre OFFLINE con arqueo correcto
    const esperado = 500 + totalLeche + 200 - 100;
    await shiftRepo.close(shift.id, { expectedCash: esperado, countedCash: esperado, difference: 0 });
    const abierto = await shiftRepo.findOpenByRegister('CAJA-1');
    check('offline: turno cerrado local (ya no hay abierto)', abierto === null, '');

    // 5. Recoonnect: sync push al servidor real
    const sync = new SyncManager(db, outbox, { apiBaseUrl: API, authToken: token, cajaId: caja.caja_id });
    const res = await sync.sync();
    check('sync: outbox drenado (6 ops, 0 errores)',
      res.failed === 0 && res.errors.length === 0,
      `synced=${res.synced} failed=${res.failed} err=${JSON.stringify(res.errors)}`);
    check('sync: sin pendientes', (await outbox.getPending()).length === 0, '');

    // 6. Estado real en el servidor
    const turno = await (await fetch(API + '/turnos/' + shift.id, { headers: H })).json();
    check('server: turno cerrado con esperado del ledger (apertura+venta+dep+retiro)',
      turno.estado === 'CERRADO' && turno.monto_esperado === esperado,
      `estado=${turno.estado} esperado=${turno.monto_esperado} (esperado ${esperado})`);

    const ventaServer = await (await fetch(API + '/ventas/' + sale.id, { headers: H })).json();
    check('server: venta persistida con el id local y precio del maestro',
      ventaServer.id === sale.id && Math.abs(ventaServer.total - totalLeche) < 0.01,
      `id=${ventaServer.id} total=${ventaServer.total}`);

    const movsServer = (turno.movimientos ?? []) as Array<{ tipo: string; monto: number }>;
    check('server: ledger con deposito y retiro autorizado',
      movsServer.some((m) => m.tipo === 'DEPOSITO' && m.monto === 200)
      && movsServer.some((m) => m.tipo === 'RETIRO' && m.monto === 100),
      `tipos=${movsServer.map((m) => m.tipo).join(',')}`);

    // ── Fase 2: apertura ONLINE (se espeja) -> corte -> venta/cierre offline -> reconexión ──
    offlineMode = false;
    const shift2 = await shiftRepo.create({ cashierId: adminId, registerId: 'CAJA-1', openingAmount: 400 });
    check('mid-cut: apertura online queda espejada localmente',
      (await db.get('shifts', shift2.id))?.estado === 'ABIERTO', '');

    offlineMode = true;
    const cart2 = new Cart();
    cart2.addItem(new CartItem(leche.id, leche.sku, leche.nombre, leche.precio, 2));
    const sale2 = await commit.execute(cart2, shift2.id, adminId, 'CASH');
    check('mid-cut: venta offline tras corte', sale2.total === totalLeche * 2, `total=${sale2.total}`);

    await shiftRepo.close(shift2.id, { expectedCash: 400 + totalLeche * 2, countedCash: 400 + totalLeche * 2, difference: 0 });

    offlineMode = false; // reconexión
    const res2 = await sync.sync();
    check('mid-cut: sync ok tras reconexion', res2.failed === 0 && res2.errors.length === 0,
      `synced=${res2.synced} failed=${res2.failed} err=${JSON.stringify(res2.errors)}`);

    const turno2 = await (await fetch(API + '/turnos/' + shift2.id, { headers: H })).json();
    check('mid-cut: turno cerrado en server con ledger',
      turno2.estado === 'CERRADO' && turno2.monto_esperado === 400 + totalLeche * 2,
      `estado=${turno2.estado} esperado=${turno2.monto_esperado}`);
  } catch (e) {
    console.log('EXCEPCION: ' + (e instanceof Error ? e.stack ?? e.message : String(e)));
    fails++;
  } finally {
    server.kill();
    setTimeout(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
      process.exit(fails > 0 ? 1 : 0);
    }, 700);
  }
})();