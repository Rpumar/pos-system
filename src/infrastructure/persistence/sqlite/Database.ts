import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Abre (o crea) el archivo de base de datos del servidor local y aplica
 * los PRAGMA necesarios para alta concurrencia lectura/escritura:
 *
 * - WAL (Write-Ahead Logging): permite lecturas concurrentes mientras
 *   hay una escritura en curso. Crítico cuando varias cajas consultan
 *   catálogo al mismo tiempo que se confirma una venta en otra.
 * - foreign_keys: SQLite las tiene desactivadas por defecto; sin esto,
 *   las REFERENCES del esquema no se validan.
 */
export function createDatabaseConnection(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Aplica database/schema.sql sobre una conexión nueva. Idempotente solo
 * en una base vacía: en producción, los cambios posteriores al esquema
 * deben aplicarse vía migraciones, no re-ejecutando este archivo.
 */
export function initializeSchema(
  db: Database.Database,
  schemaPath: string = join(__dirname, '../../../../database/schema.sql')
): void {
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
}
