export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

export class Database {
  constructor(private readonly path?: string) {
    console.warn(
      '[mock] better-sqlite3 no está disponible en el navegador ' +
        `(path: ${this.path ?? 'memoria'}). Usa container.mock.ts en desarrollo.`
    );
  }

  pragma(): void {}

  exec(): void {}

  prepare(_sql: string): Statement {
    return {
      get: () => undefined,
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    };
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return fn;
  }
}

export default Database;
