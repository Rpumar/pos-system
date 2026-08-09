/**
 * Cada ejecución de este script es un proceso del SO independiente —
 * simula UNA caja intentando vender UNA unidad del mismo producto al
 * mismo instante que otras N cajas. No comparte memoria con el
 * orquestador ni con otros workers: solo comparten el archivo SQLite.
 *
 * Usa el mismo patrón atómico exacto del Módulo 3:
 *   UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1
 *
 * Nota: este harness de verificación usa node:sqlite (nativo de Node 22,
 * sin instalación) porque este sandbox no tiene acceso a npm. El código
 * de producción del proyecto (Database.ts) usa better-sqlite3 — la API
 * de ambos es prácticamente idéntica (.prepare().run()/.get()), y la
 * garantía de atomicidad que se prueba aquí la otorga el motor SQLite
 * en sí, no el wrapper de Node.
 */
const { DatabaseSync } = require('node:sqlite');

const [, , dbPath, productId] = process.argv;

const db = new DatabaseSync(dbPath);

// Si dos procesos chocan por el lock de escritura, que esperen hasta 5s
// en vez de fallar de inmediato con SQLITE_BUSY — así se comporta una
// caja real ante contención momentánea, no se le niega la venta sin motivo.
db.exec('PRAGMA busy_timeout = 5000;');

const result = db
  .prepare('UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1')
  .run(Number(productId));

process.stdout.write(JSON.stringify({ pid: process.pid, changes: result.changes }));

db.close();
