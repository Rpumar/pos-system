/**
 * Verifica, contra SQLite real (no en memoria/simulado), que:
 *
 *  1. El consumo de lotes respeta FEFO: se gasta primero el lote que
 *     vence antes, sin importar cuál llegó primero al depósito.
 *  2. Una venta que excede un solo lote se reparte automáticamente
 *     entre varios, siempre en orden de vencimiento.
 *  3. Si products.stock y la suma real de batches.quantity quedan
 *     desincronizados (el caso que NUNCA debería pasar, pero que el
 *     sistema debe detectar), la transacción completa se revierte
 *     —incluyendo el descuento de stock ya aplicado— en vez de
 *     completar la venta con datos inconsistentes.
 *
 * Usa las MISMAS consultas SQL exactas que SqliteTransaction.ts, para
 * que este test verifique el comportamiento real, no una aproximación.
 */
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    console.log(`  ❌ ${message}`);
    failures++;
  }
}

function decrementStock(db, productId, quantity) {
  const result = db
    .prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?')
    .run(quantity, productId, quantity);
  return result.changes === 1;
}

function consumeBatchesFefo(db, productId, quantity) {
  const batches = db
    .prepare(
      `SELECT id, batch_code, quantity FROM batches
       WHERE product_id = ? AND quantity > 0
       ORDER BY expiration_date ASC`
    )
    .all(productId);

  const consumptions = [];
  let remaining = quantity;

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    const result = db
      .prepare('UPDATE batches SET quantity = quantity - ? WHERE id = ? AND quantity >= ?')
      .run(take, batch.id, take);
    if (result.changes === 1) {
      consumptions.push({ batchId: batch.id, batchCode: batch.batch_code, quantityTaken: take });
      remaining -= take;
    }
  }

  if (remaining > 0) {
    throw new Error(`InsufficientBatchCoverage: pidió ${quantity}, cubre ${quantity - remaining}`);
  }
  return consumptions;
}

function runInTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pos-fefo-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(join(__dirname, '../../database/schema.sql'), 'utf-8'));
  return { db, dir };
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// TEST 1: orden FEFO + spillover entre lotes
// ============================================================
function test1_fefoOrderAndSpillover() {
  console.log('\nTest 1: consumo FEFO con spillover entre lotes');
  const { db, dir } = setupDb();

  db.exec(
    `INSERT INTO products (sku, barcode, name, price, stock) VALUES ('LECHE-1L', '7790001', 'Leche 1L', 100, 9)`
  );
  const product = db.prepare(`SELECT id FROM products WHERE sku = 'LECHE-1L'`).get();

  // OJO: Lote A se recibe "primero" pero vence DESPUÉS que B.
  // Si el sistema usara FIFO (orden de llegada) en vez de FEFO,
  // consumiría A primero — y este test lo detectaría.
  db.exec(
    `INSERT INTO batches (product_id, batch_code, quantity, expiration_date, received_at) VALUES
     (${product.id}, 'LOTE-A', 3, '${daysFromNow(10)}', datetime('now', '-2 days')),
     (${product.id}, 'LOTE-B', 2, '${daysFromNow(5)}',  datetime('now', '-1 days')),
     (${product.id}, 'LOTE-C', 4, '${daysFromNow(20)}', datetime('now'))`
  );

  const consumed = runInTransaction(db, () => {
    decrementStock(db, product.id, 4);
    return consumeBatchesFefo(db, product.id, 4);
  });

  assert(consumed.length === 2, `se consumieron 2 lotes distintos (consumió ${consumed.length})`);
  assert(consumed[0].batchCode === 'LOTE-B', `el PRIMER lote consumido fue LOTE-B, el de vencimiento más próximo (fue ${consumed[0]?.batchCode})`);
  assert(consumed[0].quantityTaken === 2, `LOTE-B se consumió completo (2 unidades, tomó ${consumed[0]?.quantityTaken})`);
  assert(consumed[1].batchCode === 'LOTE-A', `el SEGUNDO lote consumido fue LOTE-A, no LOTE-C (fue ${consumed[1]?.batchCode})`);
  assert(consumed[1].quantityTaken === 2, `LOTE-A aportó las 2 unidades restantes (tomó ${consumed[1]?.quantityTaken})`);

  const finalStock = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock;
  const batchSum = db.prepare('SELECT SUM(quantity) as total FROM batches WHERE product_id = ?').get(product.id).total;
  assert(finalStock === 5, `products.stock quedó en 5 (quedó en ${finalStock})`);
  assert(batchSum === 5, `SUM(batches.quantity) también quedó en 5 (quedó en ${batchSum})`);
  assert(finalStock === batchSum, 'invariante stock === SUM(batches.quantity) se mantiene');

  const loteC = db.prepare(`SELECT quantity FROM batches WHERE batch_code = 'LOTE-C'`).get();
  assert(loteC.quantity === 4, `LOTE-C (el de vencimiento más lejano) quedó intacto en 4 unidades (quedó en ${loteC.quantity})`);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ============================================================
// TEST 2: rollback ante desincronización stock/lotes
// ============================================================
function test2_rollbackOnDesync() {
  console.log('\nTest 2: rollback completo si los lotes no cubren lo que products.stock promete');
  const { db, dir } = setupDb();

  // Escenario de corrupción deliberada: products.stock dice 10,
  // pero los lotes reales solo suman 5. Esto NUNCA debería ocurrir
  // si ReceiveBatchUseCase se respeta siempre, pero el sistema debe
  // protegerse igual ante datos inconsistentes (bug, migración manual, etc).
  db.exec(
    `INSERT INTO products (sku, barcode, name, price, stock) VALUES ('QUESO-500G', '7790002', 'Queso 500g', 250, 10)`
  );
  const product = db.prepare(`SELECT id FROM products WHERE sku = 'QUESO-500G'`).get();
  db.exec(
    `INSERT INTO batches (product_id, batch_code, quantity, expiration_date) VALUES
     (${product.id}, 'LOTE-X', 5, '${daysFromNow(15)}')`
  );

  let caughtError = null;
  try {
    runInTransaction(db, () => {
      const ok = decrementStock(db, product.id, 8); // 10 >= 8: esto SÍ pasa
      if (!ok) throw new Error('no debería fallar acá');
      return consumeBatchesFefo(db, product.id, 8); // pero los lotes solo cubren 5: debe fallar
    });
  } catch (e) {
    caughtError = e;
  }

  assert(caughtError !== null, 'la transacción lanzó el error esperado (InsufficientBatchCoverage)');
  assert(
    caughtError && caughtError.message.includes('InsufficientBatchCoverage'),
    `el error es del tipo correcto (fue: ${caughtError?.message})`
  );

  const stockAfterRollback = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock;
  assert(
    stockAfterRollback === 10,
    `products.stock volvió a 10 tras el ROLLBACK — el decrementStock previo se deshizo (quedó en ${stockAfterRollback})`
  );

  const batchQty = db.prepare(`SELECT quantity FROM batches WHERE batch_code = 'LOTE-X'`).get().quantity;
  assert(batchQty === 5, `LOTE-X tampoco se tocó: sigue en 5 (quedó en ${batchQty})`);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ============================================================
console.log('=== Verificación del motor de Stock y Vencimientos (FEFO) ===');
test1_fefoOrderAndSpillover();
test2_rollbackOnDesync();

console.log(`\n${failures === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${failures} CHECK(S) FALLARON`}`);
process.exit(failures === 0 ? 0 : 1);
