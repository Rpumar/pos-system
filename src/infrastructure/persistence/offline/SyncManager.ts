/**
 * SyncManager - Orquesta la sincronización entre offline y servidor
 * Maneja conflictos, reintentos y orden de operaciones
 * Soporta WebSocket para notificaciones en tiempo real
 */

import { OfflineDB } from './OfflineDB';
import { OutboxManager, OutboxOperationType } from './OutboxManager';

export interface SyncConfig {
  apiBaseUrl: string;
  wsUrl?: string;
  syncIntervalMs: number;
  maxConcurrentSync: number;
  conflictStrategy: 'server-wins' | 'client-wins' | 'manual' | 'merge';
  cajaId: string;
  authToken: string;
}

export interface SyncResult {
  synced: number;
  failed: number;
  conflicts: number;
  errors: string[];
}

export interface ConflictRecord {
  id: string;
  entityType: string;
  localData: any;
  serverData: any;
  timestamp: number;
  updatedAt: number;
  resolved: boolean;
  resolution?: 'local' | 'server' | 'merged';
}

export interface ServerPullResponse {
  timestamp: string;
  productos: any[];
  stock: any[];
  lotes: any[];
  usuarios: any[];
}

export class SyncManager {
  private db: OfflineDB;
  private outbox: OutboxManager;
  private config: SyncConfig;
  private syncing = false;
  private abortController: AbortController | null = null;
  private listeners = new Map<string, Set<Function>>();
  private ws: WebSocket | null = null;
  private wsReconnectAttempts = 0;
  private readonly maxWsReconnectAttempts = 10;

  constructor(db: OfflineDB, outbox: OutboxManager, config: Partial<SyncConfig> = {}) {
    this.db = db;
    this.outbox = outbox;
    this.config = {
      apiBaseUrl: config.apiBaseUrl ?? '/api',
      wsUrl: config.wsUrl,
      syncIntervalMs: config.syncIntervalMs ?? 30000,
      maxConcurrentSync: config.maxConcurrentSync ?? 3,
      conflictStrategy: config.conflictStrategy ?? 'server-wins',
      cajaId: config.cajaId ?? '',
      authToken: config.authToken ?? '',
    };
  }

  /**
   * Vincula el token de sesión una vez el usuario se autentica (login HTTP).
   * Sin él, push/pull fallan con 401 y las operaciones quedan pendientes.
   */
  setAuth(token: string): void {
    this.config.authToken = token;
  }

  /**
   * Vincula el id de caja una vez resuelto el registro (apertura de turno).
   */
  setCaja(cajaId: string): void {
    if (cajaId) this.config.cajaId = cajaId;
  }

  /**
   * Inicializa conexión WebSocket
   */
  async initWebSocket(): Promise<void> {
    if (!this.config.wsUrl || typeof window === 'undefined') return;

    try {
      this.ws = new WebSocket(this.config.wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        console.log('[Sync] WebSocket conectado');
        this.wsReconnectAttempts = 0;
        // Autenticar y registrar caja
        this.ws?.send(JSON.stringify({
          type: 'auth',
          token: this.config.authToken,
        }));
        this.ws?.send(JSON.stringify({
          type: 'register-caja',
          cajaId: this.config.cajaId,
        }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleWSMessage(msg);
        } catch (error) {
          console.error('[Sync] Error parseando WS message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('[Sync] WebSocket desconectado');
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('[Sync] WebSocket error:', error);
      };
    } catch (error) {
      console.error('[Sync] Error creando WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.wsReconnectAttempts >= this.maxWsReconnectAttempts) {
      console.log('[Sync] Max reconnect attempts reached');
      return;
    }
    this.wsReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);
    console.log(`[Sync] Reconectando en ${delay}ms (intento ${this.wsReconnectAttempts})`);
    setTimeout(() => this.initWebSocket(), delay);
  }

  private handleWSMessage(msg: any): void {
    switch (msg.type) {
      case 'pong':
        break;
      case 'sync:required':
        console.log('[Sync] Servidor solicita sync');
        this.sync();
        break;
      case 'data:updated':
        this.emit('remote:update', msg);
        break;
      case 'conflict:detected':
        this.emit('conflict:detected', msg);
        break;
      default:
        console.log('[Sync] WS message desconocido:', msg.type);
    }
  }

  /**
   * Inicia sincronización periódica
   */
  start(): void {
    if (this.syncInterval) return;
    this.syncInterval = setInterval(() => this.sync(), this.config.syncIntervalMs);
    this.sync(); // Inicial
    this.initWebSocket();
  }

  private syncInterval: any = null;

  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Sincronización completa
   */
  async sync(): Promise<SyncResult> {
    if (this.syncing) return { synced: 0, failed: 0, conflicts: 0, errors: ['Ya sincronizando'] };
    if (!navigator.onLine) return { synced: 0, failed: 0, conflicts: 0, errors: ['Offline'] };
    // Sin caja resuelta no hay nada que enviar/recibir: un pull con caja_id
    // vacío genera 400 en el server. Se sincroniza recién al abrir turno
    // (setCaja), cuando el push/pull son válidos.
    if (!this.config.cajaId) return { synced: 0, failed: 0, conflicts: 0, errors: [] };

    this.syncing = true;
    this.abortController = new AbortController();
    const result: SyncResult = { synced: 0, failed: 0, conflicts: 0, errors: [] };

    try {
      this.emit('sync:started', null);

      // 1. Procesar outbox (operaciones locales -> servidor)
      const outboxResult = await this.processOutbox(this.abortController.signal);
      result.synced += outboxResult.synced;
      result.failed += outboxResult.failed;
      result.errors.push(...outboxResult.errors);

      // 2. Pull cambios del servidor (servidor -> local)
      const pullResult = await this.pullChanges(this.abortController.signal);
      result.synced += pullResult.synced;
      result.conflicts += pullResult.conflicts;
      result.errors.push(...pullResult.errors);

      // 3. Evictar completadas antiguas del outbox (1/hora, no cada tick)
      const evicted = await this.outbox.cleanupThrottled();
      if (evicted > 0) console.log(`[Sync] outbox: ${evicted} operaciones completadas eliminadas`);

      this.emit('sync:completed', result);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : 'Error de sincronización');
      this.emit('sync:error', error);
    } finally {
      this.syncing = false;
    }

    return result;
  }

  /**
   * Procesa outbox: envía operaciones locales al servidor
   */
  private async processOutbox(signal: AbortSignal): Promise<{ synced: number; failed: number; errors: string[] }> {
    const result = { synced: 0, failed: 0, errors: [] as string[] };

    await this.outbox.process(async (op) => {
      if (signal.aborted) throw new Error('Sync abortado');

      try {
        await this.sendOperation(op);
        result.synced++;
      } catch (error) {
        result.failed++;
        result.errors.push(`${op.type}: ${error instanceof Error ? error.message : 'Error'}`);
        throw error; // Re-lanzar para que OutboxManager marque como fallida
      }
    });

    return result;
  }

  /**
   * Envía una operación al servidor
   */
  private async sendOperation(op: any): Promise<void> {
    const response = await fetch(`${this.config.apiBaseUrl}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.authToken}`,
      },
      body: JSON.stringify({
        caja_id: this.config.cajaId,
        operaciones: [{
          id: op.id,
          tipo: op.type, // el server espera `tipo`, no `type` (contrato de la API)
          payload: op.payload,
        }],
      }),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    const result = await response.json();
    if (result.errores && result.errores > 0) {
      throw new Error(result.detalles?.[0]?.error || 'Error en push');
    }
  }

  /**
   * Pull cambios del servidor
   */
  private async pullChanges(signal: AbortSignal): Promise<{ synced: number; conflicts: number; errors: string[] }> {
    const result = { synced: 0, conflicts: 0, errors: [] as string[] };

    try {
      const response = await fetch(`${this.config.apiBaseUrl}/sync/pull?caja_id=${this.config.cajaId}&since=${await this.getLastSyncTimestamp()}`, {
        headers: { 'Authorization': `Bearer ${this.config.authToken}` },
        signal: this.abortController?.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: ServerPullResponse = await response.json();

      // Procesar productos
      for (const prod of data.productos) {
        const conflict = await this.mergeRecord('productos', prod);
        if (conflict) result.conflicts++;
        else result.synced++;
      }

      // Procesar stock: el server usa PK (producto_id, sucursal_id) sin `id`.
      // El store offline exige `id` como keyPath -> sintetizarlo o el put
      // lanza DataError y el pull no guarda nada de stock.
      for (const stock of data.stock) {
        const id = String(stock.id ?? `${String(stock.producto_id)}:${String(stock.sucursal_id)}`);
        await this.db.put('stock_sucursal', { ...stock, id, syncedAt: Date.now() });
        result.synced++;
      }

      // Procesar lotes
      for (const lote of data.lotes) {
        await this.db.put('lotes', { ...lote, syncedAt: Date.now() });
        result.synced++;
      }

      // Procesar usuarios
      for (const user of data.usuarios) {
        await this.db.put('usuarios', { ...user, syncedAt: Date.now() });
        result.synced++;
      }

      await this.setLastSyncTimestamp(Date.now());
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : 'Error en pull');
    }

    return result;
  }

  /**
   * Merge registro del servidor con local (conflict resolution)
   */
  private async mergeRecord(entity: string, serverRecord: any): Promise<boolean> {
    const localRecord = await this.db.get<{ id: string; updatedAt?: number }>(entity, serverRecord.id);

    if (!localRecord) {
      const freshTs = serverRecord.updated_at ? (new Date(serverRecord.updated_at).getTime() || 0) : 0;
      await this.db.put(entity, { ...serverRecord, updatedAt: freshTs, syncedAt: Date.now() });
      return false;
    }

    const localUpdated = localRecord.updatedAt || 0;
    // El server manda `updated_at` (ISO); el registro local guarda ms en
    // `updatedAt`. Normalizar a ms para comparar correctamente, o el catálogo
    // nunca se refresca (updatedAt nunca cambia en las filas del server).
    const serverRaw = serverRecord.updated_at ?? serverRecord.updatedAt;
    const serverUpdated = serverRaw ? (new Date(serverRaw).getTime() || 0) : 0;
    const lastSync = await this.getLastSyncTimestamp();

    if (localUpdated > lastSync && serverUpdated > lastSync) {
      return this.resolveConflict(entity, localRecord, serverRecord);
    }

    if (serverUpdated > localUpdated) {
      await this.db.put(entity, { ...serverRecord, updatedAt: serverUpdated, syncedAt: Date.now() });
    }

    return false;
  }

  /**
   * Resuelve conflicto según estrategia configurada
   */
  private async resolveConflict(entity: string, local: any, server: any): Promise<boolean> {
    const conflictRecord: ConflictRecord = {
      id: `${entity}-${local.id}-${Date.now()}`,
      entityType: entity,
      localData: local,
      serverData: server,
      timestamp: Date.now(),
      updatedAt: Date.now(),
      resolved: false,
    };

    let resolution: 'local' | 'server' | 'merged' = 'server';
    let merged: any = server;

    switch (this.config.conflictStrategy) {
      case 'server-wins':
        merged = server;
        resolution = 'server';
        break;
      case 'client-wins':
        merged = local;
        resolution = 'local';
        break;
      case 'merge':
        merged = { ...server, ...local };
        resolution = 'merged';
        break;
      case 'manual':
        await this.db.put('conflicts', conflictRecord);
        this.emit('conflict:detected', conflictRecord);
        return true;
    }

    await this.db.put(entity, { ...merged, syncedAt: Date.now() });
    conflictRecord.resolved = true;
    conflictRecord.resolution = resolution;
    await this.db.put('conflicts', conflictRecord);

    this.emit('conflict:resolved', { ...conflictRecord, resolution });
    return true;
  }

  /**
   * Resolución manual de conflicto
   */
  async resolveConflictManually(conflictId: string, choice: 'local' | 'server' | 'merged', mergedData?: any): Promise<void> {
    const conflict = await this.db.get<ConflictRecord>('conflicts', conflictId);
    if (!conflict || conflict.resolved) throw new Error('Conflicto no encontrado o ya resuelto');

    let merged: any;
    if (choice === 'merged' && mergedData) {
      merged = mergedData;
    } else if (choice === 'local') {
      merged = conflict.localData;
    } else {
      merged = conflict.serverData;
    }

    await this.db.put(conflict.entityType, { ...merged, syncedAt: Date.now() });
    conflict.resolved = true;
    conflict.resolution = choice;
    await this.db.put('conflicts', conflict);

    this.emit('conflict:resolved', conflict);
  }

  /**
   * Obtiene conflictos pendientes
   */
  async getPendingConflicts(): Promise<ConflictRecord[]> {
    return this.db.getByIndex('conflicts', 'resolved', false);
  }

  // Helpers
  private async getLastSyncTimestamp(): Promise<number> {
    const meta = await this.db.get<{ id: string; value: number }>('meta', 'lastSync');
    return meta?.value || 0;
  }

  private async setLastSyncTimestamp(ts: number): Promise<void> {
    await this.db.put('meta', { id: 'lastSync', value: ts, updatedAt: ts });
  }

  // Eventos
  on(event: string, callback: Function): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: any): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }
}