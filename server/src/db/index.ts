import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import initSqlJs from 'sql.js';
import { v4 as uuidv4 } from 'uuid';

const DB_PATH = process.env.POS_SERVER_DB_PATH ?? join(process.cwd(), 'data', 'pos-server.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

let database: any = null;
let dbAdapter: any = null;

function getRawDB(): any {
  if (!database) throw new Error('Database no inicializada. Llama initializeDatabase() primero.');
  return database;
}

function getDB(): any {
  if (!dbAdapter) {
    dbAdapter = createDbAdapter(getRawDB());
  }
  return dbAdapter;
}

// Adaptador que expone la API estilo better-sqlite3 (get/all/run/transaction)
// sobre sql.js, usada por las rutas.
function createDbAdapter(rawDb: any): any {
  const toParams = (args: any[]): any[] => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);

  return {
    prepare(sql: string): any {
      const stmt = rawDb.prepare(sql);
      const free = () => {
        try { stmt.free(); } catch { /* noop */ }
      };
      return {
        get(...p: any[]): any {
          stmt.bind(toParams(p));
          if (stmt.step()) {
            const row = stmt.getAsObject();
            free();
            return row;
          }
          free();
          return undefined;
        },
        all(...p: any[]): any[] {
          stmt.bind(toParams(p));
          const rows: any[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          free();
          return rows;
        },
        run(...p: any[]): { changes: number; lastInsertRowid: number } {
          stmt.bind(toParams(p));
          stmt.step();
          let changes = 0;
          const ch = rawDb.prepare('SELECT changes() AS c');
          ch.bind([]);
          if (ch.step()) changes = Number(ch.getAsObject().c ?? 0);
          ch.free();
          free();
          return { changes, lastInsertRowid: 0 };
        },
      };
    },
    transaction(fn: (...a: any[]) => any): (...a: any[]) => any {
      return (...args: any[]) => {
        rawDb.exec('BEGIN TRANSACTION;');
        try {
          const result = fn(...args);
          rawDb.exec('COMMIT;');
          return result;
        } catch (error) {
          rawDb.exec('ROLLBACK;');
          throw error;
        }
      };
    },
    exec(sql: string): void {
      rawDb.exec(sql);
    },
  };
}

function runQuery(sql: string, params: any[] = []): any[] {
  const db = getRawDB();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function runExec(sql: string, params: any[] = []): void {
  const db = getRawDB();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

function runTransaction(queries: Array<{ sql: string; params: any[] }>): void {
  const db = getRawDB();
  db.exec('BEGIN TRANSACTION;');
  try {
    for (const { sql, params } of queries) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function seedInitialData(): void {
  const sucursalId = uuidv4();
  runExec('INSERT INTO sucursales (id, nombre, direccion, telefono, email) VALUES (?, ?, ?, ?, ?)', [sucursalId, 'Sucursal Central', 'Av. Principal 123', '+54 11 1234-5678', 'central@pos.com']);

  for (let i = 1; i <= 4; i++) {
    const cajaId = uuidv4();
    runExec('INSERT INTO cajas (id, sucursal_id, nombre, estado) VALUES (?, ?, ?, ?)', [cajaId, sucursalId, 'CAJA-' + i, 'ACTIVE']);
  }

  const adminId = uuidv4();
  const bcrypt = require('bcryptjs');
  const pinHash = bcrypt.hashSync('1234', 10);
  runExec('INSERT INTO usuarios (id, sucursal_id, nombre, email, pin_hash, role) VALUES (?, ?, ?, ?, ?, ?)', [adminId, sucursalId, 'Administrador', 'admin@pos.com', pinHash, 'ADMIN']);

  for (let i = 1; i <= 4; i++) {
    const cajeroId = uuidv4();
    const pinHash = bcrypt.hashSync('1234', 10);
    runExec('INSERT INTO usuarios (id, sucursal_id, nombre, email, pin_hash, role) VALUES (?, ?, ?, ?, ?, ?)', [cajeroId, sucursalId, 'Cajero ' + i, 'cajero' + i + '@pos.com', pinHash, 'CASHIER']);
  }

  const supId = uuidv4();
  const supPinHash = bcrypt.hashSync('9999', 10);
  runExec('INSERT INTO usuarios (id, sucursal_id, nombre, email, pin_hash, role) VALUES (?, ?, ?, ?, ?, ?)', [supId, sucursalId, 'Supervisor General', 'supervisor@pos.com', supPinHash, 'SUPERVISOR']);

  const catalog: Array<[string, string, string, number]> = [
    ['LEC-001', '7790010000015', 'Leche Entera 1L', 62.5],
    ['PAN-001', '7790010000022', 'Pan Blanco 500g', 55],
    ['HUE-001', '7790010000039', 'Huevos Docena', 145],
    ['ARR-001', '7790010000046', 'Arroz 1kg', 98],
    ['FID-001', '7790010000053', 'Fideos Tallarines 500g', 42.5],
    ['ACE-001', '7790010000060', 'Aceite Girasol 900ml', 320],
    ['AZU-001', '7790010000077', 'Azúcar 1kg', 118],
    ['CAF-001', '7790010000084', 'Café Molido 250g', 285],
    ['GAL-001', '7790010000091', 'Galletitas Surtidas', 75],
    ['AGU-001', '7790010000107', 'Agua Mineral 2L', 88],
  ];

  for (const [sku, barcode, nombre, precio] of catalog) {
    const prodId = uuidv4();
    runExec(
      'INSERT INTO productos (id, sku, barcode, nombre, descripcion, precio, costo, impuesto, stock_central, activo) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)',
      [prodId, sku, barcode, nombre, null, precio, Math.round(precio * 0.6 * 100) / 100, 200]
    );
    runExec(
      'INSERT INTO stock_sucursal (producto_id, sucursal_id, cantidad, minimo, maximo, ubicacion) VALUES (?, ?, ?, ?, ?, ?)',
      [prodId, sucursalId, 50, 10, 100, 'Góndola A']
    );
  }

  console.log('[Server] Datos iniciales creados');
}

function initializeSchema(): void {
  runExec('CREATE TABLE IF NOT EXISTS sucursales (id TEXT PRIMARY KEY, nombre TEXT NOT NULL, direccion TEXT, telefono TEXT, email TEXT, activa INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE TABLE IF NOT EXISTS cajas (id TEXT PRIMARY KEY, sucursal_id TEXT NOT NULL REFERENCES sucursales(id), nombre TEXT NOT NULL, estado TEXT NOT NULL DEFAULT \'ACTIVE\' CHECK (estado IN (\'ACTIVE\', \'INACTIVE\', \'MAINTENANCE\')), last_sync TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE TABLE IF NOT EXISTS usuarios (id TEXT PRIMARY KEY, sucursal_id TEXT NOT NULL REFERENCES sucursales(id), nombre TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN (\'CASHIER\', \'SUPERVISOR\', \'ADMIN\', \'MANAGER\')), activa INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE TABLE IF NOT EXISTS productos (id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, barcode TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, descripcion TEXT, precio REAL NOT NULL CHECK (precio >= 0), costo REAL CHECK (costo >= 0), impuesto REAL NOT NULL DEFAULT 0.21, stock_central INTEGER NOT NULL DEFAULT 0 CHECK (stock_central >= 0), activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE TABLE IF NOT EXISTS stock_sucursal (producto_id TEXT NOT NULL REFERENCES productos(id), sucursal_id TEXT NOT NULL REFERENCES sucursales(id), cantidad INTEGER NOT NULL DEFAULT 0 CHECK (cantidad >= 0), minimo INTEGER NOT NULL DEFAULT 0, maximo INTEGER NOT NULL DEFAULT 0, ubicacion TEXT, PRIMARY KEY (producto_id, sucursal_id));');
  runExec('CREATE TABLE IF NOT EXISTS lotes (id TEXT PRIMARY KEY, producto_id TEXT NOT NULL REFERENCES productos(id), sucursal_id TEXT NOT NULL REFERENCES sucursales(id), codigo_lote TEXT NOT NULL, cantidad INTEGER NOT NULL CHECK (cantidad >= 0), fecha_vencimiento TEXT NOT NULL, fecha_recepcion TEXT NOT NULL DEFAULT (datetime(\'now\')), proveedor TEXT);');
  runExec('CREATE TABLE IF NOT EXISTS turnos (id TEXT PRIMARY KEY, caja_id TEXT NOT NULL REFERENCES cajas(id), usuario_id TEXT NOT NULL REFERENCES usuarios(id), sucursal_id TEXT NOT NULL REFERENCES sucursales(id), monto_apertura REAL NOT NULL, monto_esperado REAL, monto_contado REAL, diferencia REAL, estado TEXT NOT NULL DEFAULT \'ABIERTO\' CHECK (estado IN (\'ABIERTO\', \'CERRADO\', \'CON_DESCUADRE\')), opened_at TEXT NOT NULL DEFAULT (datetime(\'now\')), closed_at TEXT, synced_at TEXT);');
  runExec('CREATE TABLE IF NOT EXISTS ventas (id TEXT PRIMARY KEY, turno_id TEXT NOT NULL REFERENCES turnos(id), caja_id TEXT NOT NULL REFERENCES cajas(id), sucursal_id TEXT NOT NULL REFERENCES sucursales(id), usuario_id TEXT NOT NULL REFERENCES usuarios(id), estado TEXT NOT NULL DEFAULT \'PENDIENTE\' CHECK (estado IN (\'PENDIENTE\', \'PAGADA\', \'ANULADA\', \'DEVUELTA\')), metodo_pago TEXT CHECK (metodo_pago IN (\'EFECTIVO\', \'TARJETA\', \'TRANSFERENCIA\', \'MIXTO\')), codigo_autorizacion TEXT, subtotal REAL NOT NULL DEFAULT 0, impuestos REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), synced_at TEXT);');
  runExec('CREATE TABLE IF NOT EXISTS venta_detalles (id TEXT PRIMARY KEY, venta_id TEXT NOT NULL REFERENCES ventas(id), producto_id TEXT NOT NULL REFERENCES productos(id), cantidad INTEGER NOT NULL CHECK (cantidad > 0), precio_unitario REAL NOT NULL, impuesto REAL NOT NULL, subtotal REAL NOT NULL, lote_id TEXT REFERENCES lotes(id));');
  runExec('CREATE TABLE IF NOT EXISTS movimientos_stock (id TEXT PRIMARY KEY, producto_id TEXT NOT NULL REFERENCES productos(id), sucursal_id TEXT NOT NULL REFERENCES sucursales(id), tipo TEXT NOT NULL CHECK (tipo IN (\'ENTRADA\', \'SALIDA\', \'AJUSTE\', \'TRANSFERENCIA\', \'VENCIMIENTO\', \'DEVOLUCION\')), cantidad INTEGER NOT NULL, motivo TEXT, referencia_id TEXT, usuario_id TEXT REFERENCES usuarios(id), created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE TABLE IF NOT EXISTS movimientos_caja (id TEXT PRIMARY KEY, turno_id TEXT NOT NULL REFERENCES turnos(id), tipo TEXT NOT NULL CHECK (tipo IN (\'VENTA_EFECTIVO\', \'RETIRO\', \'DEPOSITO\', \'DEVOLUCION\', \'APERTURA\', \'CIERRE\')), monto REAL NOT NULL, motivo TEXT, autorizado_por TEXT REFERENCES usuarios(id), referencia_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE TABLE IF NOT EXISTS auditoria (id TEXT PRIMARY KEY, usuario_id TEXT NOT NULL REFERENCES usuarios(id), accion TEXT NOT NULL, entidad TEXT, entidad_id TEXT, metadatos TEXT, ip TEXT, user_agent TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE TABLE IF NOT EXISTS sync_log (id TEXT PRIMARY KEY, caja_id TEXT NOT NULL REFERENCES cajas(id), tipo TEXT NOT NULL CHECK (tipo IN (\'PUSH\', \'PULL\', \'FULL\')), registros_enviados INTEGER DEFAULT 0, registros_recibidos INTEGER DEFAULT 0, conflictos INTEGER DEFAULT 0, estado TEXT NOT NULL CHECK (estado IN (\'EXITOSO\', \'PARCIAL\', \'FALLIDO\')), error TEXT, duracion_ms INTEGER, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runExec('CREATE INDEX IF NOT EXISTS idx_ventas_sucursal_fecha ON ventas(sucursal_id, created_at);');
  runExec('CREATE INDEX IF NOT EXISTS idx_ventas_turno ON ventas(turno_id);');
  runExec('CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado);');
  runExec('CREATE INDEX IF NOT EXISTS idx_turnos_caja_estado ON turnos(caja_id, estado);');
  runExec('CREATE INDEX IF NOT EXISTS idx_stock_sucursal ON stock_sucursal(sucursal_id, cantidad);');
  runExec('CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento ON lotes(fecha_vencimiento, sucursal_id) WHERE cantidad > 0;');
  runExec('CREATE INDEX IF NOT EXISTS idx_auditoria_usuario_fecha ON auditoria(usuario_id, created_at);');
  runExec('CREATE INDEX IF NOT EXISTS idx_sync_log_caja_fecha ON sync_log(caja_id, created_at);');
  runExec('CREATE INDEX IF NOT EXISTS idx_productos_sku ON productos(sku);');
  runExec('CREATE INDEX IF NOT EXISTS idx_productos_barcode ON productos(barcode);');

  const sucursalesCount = runQuery('SELECT COUNT(*) as c FROM sucursales')[0] as { c: number };
  if (sucursalesCount.c === 0) {
    seedInitialData();
  }
}

async function initializeDatabase(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });

  let fileBuffer: Uint8Array | null = null;
  try {
    const fs = await import('fs');
    fileBuffer = fs.readFileSync(DB_PATH);
  } catch {
  }

  database = new SQL.Database(fileBuffer);
  dbAdapter = null;

  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA journal_mode = WAL;');

  initializeSchema();

  setInterval(() => {
    const fs = require('fs');
    const data = database.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 5000);
}

function saveDB(): void {
  if (!database) return;
  const fs = require('fs');
  const data = database.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function closeDB(): void {
  if (!database) return;
  const fs = require('fs');
  const data = database.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  database.close();
}

export { runQuery, runExec, runTransaction, getDB, saveDB, closeDB, initializeSchema, initializeDatabase };