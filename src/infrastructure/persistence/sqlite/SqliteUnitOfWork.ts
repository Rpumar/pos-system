import type Database from 'better-sqlite3';
import { IUnitOfWork, ITransaction } from '../../../application/ports/IUnitOfWork';
import { SqliteTransaction } from './SqliteTransaction';

export class SqliteUnitOfWork implements IUnitOfWork {
  constructor(private readonly db: Database.Database) {}

  async execute<T>(work: (tx: ITransaction) => T): Promise<T> {
    // better-sqlite3 envuelve esto en BEGIN/COMMIT y hace ROLLBACK
    // automático si `work` lanza una excepción — esa es la garantía
    // de atomicidad de la que depende CommitSaleUseCase.
    const runInTransaction = this.db.transaction((tx: ITransaction) => work(tx));
    return runInTransaction(new SqliteTransaction(this.db));
  }
}
