/**
 * Test de concurrencia real (no simulado en un solo hilo).
 *
 * Crea una base SQLite temporal con el esquema REAL del proyecto,
 * siembra un único producto con stock conocido, y dispara N procesos
 * del sistema operativo de forma simultánea —cada uno una "venta"
 * independiente— para verificar que nunca se vende más stock del
 * que existe, incluso bajo contención real entre cajas distintas.
 *
 * Invariante que se valida:
 *   ventas_exitosas === stock_inicial
 *   stock_final === 0
 *   stock_final nunca negativo
 */
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const INITIAL_STOCK = 5;
const CONCURRENT_ATTEMPTS = 20;
const SCHEMA_PATH = join(__dirname, '../../database/schema.sql');
const WORKER_PATH = join(__dirname, 'decrement-worker.cjs');

function runWorker(dbPath, productId) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [WORKER_PATH, dbPath, String(productId)]);
    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.on('close', () => {
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        reject(new Error('Worker no devolvió JSON válido: ' + output));
      }
    });
    child.on('error', reject);
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'pos-stress-'));
  const dbPath = join(dir, 'test.db');

  // 1. Base de datos real, con el schema.sql tal cual lo usa el proyecto.
  const setupDb = new DatabaseSync(dbPath);
  setupDb.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
  setupDb.exec(
    `INSERT INTO products (sku, barcode, name, price, stock)
     VALUES ('TEST-001', '7791234567890', 'Producto de Prueba', 100.0, ${INITIAL_STOCK});`
  );
  const product = setupDb.prepare('SELECT id FROM products WHERE sku = ?').get('TEST-001');
  setupDb.close(); // cerramos ANTES de lanzar los workers: no queremos competir nosotros por el lock

  console.log(`Base de datos temporal: ${dbPath}`);
  console.log(`Stock inicial: ${INITIAL_STOCK} unidades`);
  console.log(`Disparando ${CONCURRENT_ATTEMPTS} "ventas" simultáneas en procesos del SO separados...\n`);

  const start = Date.now();
  // Promise.all sin await secuencial: los 20 procesos se lanzan TODOS
  // antes de que el primero termine. Esto es concurrencia real de SO,
  // no un loop disfrazado.
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_ATTEMPTS }, () => runWorker(dbPath, product.id))
  );
  const elapsed = Date.now() - start;

  const successes = results.filter((r) => r.changes === 1).length;
  const failures = results.filter((r) => r.changes === 0).length;

  const finalDb = new DatabaseSync(dbPath);
  const finalProduct = finalDb.prepare('SELECT stock FROM products WHERE id = ?').get(product.id);
  finalDb.close();

  console.log(`Tiempo total:      ${elapsed}ms`);
  console.log(`Ventas exitosas:   ${successes}`);
  console.log(`Ventas rechazadas: ${failures}`);
  console.log(`Stock final en BD: ${finalProduct.stock}\n`);

  const invariantHolds = successes === INITIAL_STOCK && finalProduct.stock === 0;

  console.log(
    invariantHolds
      ? '✅ INVARIANTE SOSTENIDA: nunca se vendió más stock del disponible bajo concurrencia real.'
      : '❌ FALLO: se detectó una condición de carrera (overselling).'
  );

  rmSync(dir, { recursive: true, force: true });
  process.exit(invariantHolds ? 0 : 1);
}

main().catch((err) => {
  console.error('Error en el test:', err);
  process.exit(1);
});
