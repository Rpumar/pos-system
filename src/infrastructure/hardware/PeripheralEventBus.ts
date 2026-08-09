export type PeripheralEventType =
  | 'printer:out-of-paper'
  | 'printer:ready'
  | 'printer:job-failed'
  | 'printer:cover-open'
  | 'printer:error'
  | 'terminal:circuit-open'
  | 'terminal:reconnected'
  | 'scanner:connected'
  | 'scanner:disconnected'
  | 'scanner:scan'
  | 'server:offline-fallback'
  | 'sync:batch-completed';

export interface PeripheralEventPayloads {
  'printer:out-of-paper': undefined;
  'printer:ready': undefined;
  'printer:job-failed': { saleId: string };
  'printer:cover-open': undefined;
  'printer:error': { message: string };
  'terminal:circuit-open': { until: number };
  'terminal:reconnected': undefined;
  'scanner:connected': { type: string };
  'scanner:disconnected': { type: string };
  'scanner:scan': { barcode: string; type: string };
  'server:offline-fallback': undefined;
  'sync:batch-completed': { count: number };
}

type Listener<T extends PeripheralEventType> = (payload: PeripheralEventPayloads[T]) => void;

export class PeripheralEventBus {
  private listeners = new Map<PeripheralEventType, Set<Listener<PeripheralEventType>>>();

  emit<T extends PeripheralEventType>(type: T, payload: PeripheralEventPayloads[T]): void {
    this.listeners.get(type)?.forEach((cb) => cb(payload as PeripheralEventPayloads[PeripheralEventType]));
  }

  on<T extends PeripheralEventType>(type: T, callback: Listener<T>): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(callback as Listener<PeripheralEventType>);
    // Devuelve el unsubscribe para uso limpio en useEffect.
    return () => this.listeners.get(type)!.delete(callback as Listener<PeripheralEventType>);
  }
}
