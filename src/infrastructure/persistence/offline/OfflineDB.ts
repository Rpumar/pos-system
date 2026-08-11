/**
 * IndexedDB wrapper for offline-first storage
 * Provides a simple key-value interface with transactions support
 */

export interface IDBConfig {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    keyPath: string;
    indexes?: Array<{ name: string; keyPath: string; unique?: boolean }>;
  }>;
}

export interface SyncableRecord {
  id: string;
  updatedAt: number;
  syncedAt?: number;
  deleted?: boolean;
  [key: string]: any;
}

type IDBTransactionMode = 'readonly' | 'readwrite';

export class OfflineDB {
  private db: IDBDatabase | null = null;
  private readonly config: IDBConfig;
  private initPromise: Promise<void> | null = null;

  constructor(config: IDBConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        reject(new Error('IndexedDB no disponible'));
        return;
      }

      const request = window.indexedDB.open(this.config.name, this.config.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        for (const store of this.config.stores) {
          if (!db.objectStoreNames.contains(store.name)) {
            const objectStore = db.createObjectStore(store.name, { keyPath: store.keyPath });
            if (store.indexes) {
              for (const index of store.indexes) {
                objectStore.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
              }
            }
          }
        }
      };
    });

    return this.initPromise;
  }

  private async getStore(storeName: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await this.init();
    if (!this.db) throw new Error('DB no inicializada');
    const transaction = this.db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  }

  async put<T extends SyncableRecord>(storeName: string, record: T): Promise<void> {
    const store = await this.getStore(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put({ ...record, updatedAt: Date.now() });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async get<T>(storeName: string, id: string): Promise<T | undefined> {
    const store = await this.getStore(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    const store = await this.getStore(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getByIndex<T>(storeName: string, indexName: string, value: any): Promise<T[]> {
    const store = await this.getStore(storeName, 'readonly');
    const index = store.index(indexName);
    return new Promise((resolve, reject) => {
      const request = index.getAll(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(storeName: string, id: string): Promise<void> {
    const store = await this.getStore(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(storeName: string): Promise<void> {
    const store = await this.getStore(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async count(storeName: string): Promise<number> {
    const store = await this.getStore(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Transacción múltiple atómica
  async transaction<T>(storeNames: string[], mode: IDBTransactionMode, callback: (stores: Map<string, IDBObjectStore>) => Promise<T>): Promise<T> {
    await this.init();
    if (!this.db) throw new Error('DB no inicializada');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeNames, mode);
      const stores = new Map<string, IDBObjectStore>();
      for (const name of storeNames) {
        stores.set(name, transaction.objectStore(name));
      }

      Promise.resolve(callback(stores))
        .then(resolve)
        .catch(reject);

      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(new Error('Transacción abortada'));
    });
  }

  // Obtener registros pendientes de sincronización.
  // NO depende de un índice 'syncedAt' (el store outbox no lo tiene): filtra
  // por getAll, correcto para el volumen reducido del outbox local.
  async getPendingSync(storeName: string, limit = 100): Promise<SyncableRecord[]> {
    const all = await this.getAll<SyncableRecord>(storeName);
    return all
      .filter((r) => r.syncedAt === undefined || r.syncedAt <= 0)
      .slice(0, limit);
  }

  // Marcar como sincronizado
  async markSynced(storeName: string, id: string): Promise<void> {
    const record = await this.get<SyncableRecord>(storeName, id);
    if (record) {
      await this.put(storeName, { ...record, syncedAt: Date.now() });
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }
}

// Factory para la DB del POS
export function createPOSOfflineDB(): OfflineDB {
  return new OfflineDB({
    name: 'pos-offline',
    version: 1,
    stores: [
      {
        name: 'sales',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'shiftId', keyPath: 'shiftId' },
          { name: 'status', keyPath: 'status' },
        ],
      },
      {
        name: 'sale_details',
        keyPath: 'id',
        indexes: [
          { name: 'saleId', keyPath: 'saleId' },
          { name: 'productId', keyPath: 'productId' },
        ],
      },
      {
        name: 'stock_movements',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'productId', keyPath: 'productId' },
        ],
      },
      {
        name: 'cash_movements',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'shiftId', keyPath: 'shiftId' },
        ],
      },
      {
        name: 'shifts',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'status', keyPath: 'status' },
        ],
      },
      {
        name: 'productos',
        keyPath: 'id',
        indexes: [
          // Catálogo maestro traído por SyncManager.pullChanges (DTO del server)
          { name: 'syncedAt', keyPath: 'syncedAt' },
          // No-únicos a propósito: el server puede traer duplicados/nulos y un
          // índice unique lanzaría ConstraintError en el pull (perdiendo catálogo).
          { name: 'sku', keyPath: 'sku' },
          { name: 'barcode', keyPath: 'barcode' },
        ],
      },
      {
        name: 'stock_sucursal',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'producto_id', keyPath: 'producto_id' },
        ],
      },
      {
        name: 'lotes',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'producto_id', keyPath: 'producto_id' },
        ],
      },
      {
        name: 'usuarios',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
        ],
      },
      {
        name: 'batches',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'productId', keyPath: 'productId' },
        ],
      },
      {
        name: 'audit_log',
        keyPath: 'id',
        indexes: [
          { name: 'syncedAt', keyPath: 'syncedAt' },
          { name: 'userId', keyPath: 'userId' },
        ],
      },
      {
        name: 'outbox',
        keyPath: 'id',
        indexes: [
          { name: 'createdAt', keyPath: 'createdAt' },
          { name: 'type', keyPath: 'type' },
          { name: 'status', keyPath: 'status' },
        ],
      },
      {
        name: 'conflicts',
        keyPath: 'id',
        indexes: [
          { name: 'resolved', keyPath: 'resolved' },
          { name: 'entityType', keyPath: 'entityType' },
        ],
      },
      {
        name: 'meta',
        keyPath: 'id',
        indexes: [],
      },
    ],
  });
}