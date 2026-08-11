/**
 * Punto de entrada de la carpeta offline-first.
 * Facilita imports desde la UI y herramientas de scripting.
 */

export { OfflineDB, createPOSOfflineDB } from './OfflineDB';
export type { IDBConfig, SyncableRecord } from './OfflineDB';
export { OutboxManager } from './OutboxManager';
export type { OutboxOperation, OutboxOperationType, OutboxConfig } from './OutboxManager';
export { SyncManager } from './SyncManager';
export type { SyncConfig, SyncResult, ConflictRecord, ServerPullResponse } from './SyncManager';
export { NetworkDetector } from './NetworkDetector';
export type { NetworkStatus } from './NetworkDetector';
export {
  OfflineShiftRepository,
  OfflineUnitOfWork,
  OfflineProductRepository,
  buildOfflineDeps,
} from './OfflineRepoAdapter';
export type { OfflineDeps, RegisterResolutionCache } from './OfflineRepoAdapter';