/**
 * Outbox pattern implementation for reliable offline operations
 * Stores operations locally and syncs when online
 */

export type OutboxOperationType =
  | 'CREATE_SALE'
  | 'UPDATE_SALE'
  | 'CREATE_SHIFT'
  | 'CLOSE_SHIFT'
  | 'CREATE_STOCK_MOVEMENT'
  | 'CREATE_CASH_MOVEMENT'
  | 'CREATE_PRODUCT'
  | 'UPDATE_PRODUCT'
  | 'CREATE_BATCH'
  | 'CREATE_AUDIT_LOG';

export interface OutboxOperation {
  id: string;
  type: OutboxOperationType;
  payload: any;
  createdAt: number;
  retries: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  lastError?: string;
}

export interface OutboxConfig {
  maxRetries: number;
  retryDelayMs: number;
  batchSize: number;
}

export class OutboxManager {
  private db: any; // OfflineDB
  private config: OutboxConfig;
  private processing = false;
  private syncInterval: any = null;
  private listeners = new Map<string, Set<Function>>();

  constructor(db: any, config: Partial<OutboxConfig> = {}) {
    this.db = db;
    this.config = {
      maxRetries: config.maxRetries ?? 5,
      retryDelayMs: config.retryDelayMs ?? 5000,
      batchSize: config.batchSize ?? 50,
    };
  }

  /**
   * Agrega una operación al outbox
   */
  async enqueue(type: OutboxOperationType, payload: any): Promise<string> {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const operation: OutboxOperation = {
      id,
      type,
      payload,
      createdAt: Date.now(),
      retries: 0,
      status: 'pending',
    };

    await this.db.put('outbox', operation);
    this.emit('enqueued', operation);
    return id;
  }

  /**
   * Obtiene operaciones pendientes
   */
  async getPending(): Promise<OutboxOperation[]> {
    return this.db.getPendingSync('outbox', this.config.batchSize);
  }

  /**
   * Marca operación como procesando
   */
  async markProcessing(id: string): Promise<void> {
    const op = await this.db.get('outbox', id);
    if (op) {
      op.status = 'processing';
      await this.db.put('outbox', op);
    }
  }

  /**
   * Marca operación como completada
   */
  async markCompleted(id: string): Promise<void> {
    const op = await this.db.get('outbox', id);
    if (op) {
      op.status = 'completed';
      op.syncedAt = Date.now();
      await this.db.put('outbox', op);
      this.emit('completed', op);
    }
  }

  /**
   * Marca operación como fallida (para reintento)
   */
  async markFailed(id: string, error: string): Promise<void> {
    const op = await this.db.get('outbox', id);
    if (op) {
      op.retries++;
      op.lastError = error;
      if (op.retries >= this.config.maxRetries) {
        op.status = 'failed';
      } else {
        op.status = 'pending';
      }
      await this.db.put('outbox', op);
      this.emit('failed', op);
    }
  }

  /**
   * Procesa el outbox - llama al handler para cada operación
   */
  async process(handler: (op: OutboxOperation) => Promise<void>): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const pending = await this.getPending();
      for (const op of pending) {
        await this.markProcessing(op.id);
        try {
          await handler(op);
          await this.markCompleted(op.id);
        } catch (error) {
          await this.markFailed(op.id, error instanceof Error ? error.message : 'Error desconocido');
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Inicia procesamiento periódico
   */
  startPeriodicSync(handler: (op: OutboxOperation) => Promise<void>, intervalMs = 30000): void {
    if (this.syncInterval) return;
    this.syncInterval = setInterval(() => {
      this.process(handler).catch(err => console.error('[Outbox] Error en sync:', err));
    }, intervalMs);
    // Ejecutar inmediatamente
    this.process(handler).catch(err => console.error('[Outbox] Error en sync inicial:', err));
  }

  /**
   * Detiene procesamiento periódico
   */
  stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /**
   * Eventos
   */
  on(event: string, callback: Function): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: any): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }

  /**
   * Limpia operaciones completadas antiguas
   */
  async cleanup(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const all = await this.db.getAll('outbox');
    const cutoff = Date.now() - olderThanMs;
    let deleted = 0;
    for (const op of all) {
      if (op.status === 'completed' && op.syncedAt && op.syncedAt < cutoff) {
        await this.db.delete('outbox', op.id);
        deleted++;
      }
    }
    return deleted;
  }
}