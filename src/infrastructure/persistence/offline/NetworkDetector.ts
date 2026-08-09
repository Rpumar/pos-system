/**
 * Network status detection for offline-first applications
 */

export type NetworkStatus = 'online' | 'offline' | 'unknown';

export interface NetworkStatusOptions {
  checkIntervalMs?: number;
  checkUrl?: string;
  timeoutMs?: number;
}

export class NetworkDetector {
  private status: NetworkStatus = 'unknown';
  private listeners = new Set<(status: NetworkStatus) => void>();
  private checkInterval: any = null;
  private options: Required<NetworkStatusOptions>;

  constructor(options: NetworkStatusOptions = {}) {
    this.options = {
      checkIntervalMs: options.checkIntervalMs ?? 10000,
      checkUrl: options.checkUrl ?? '/api/health',
      timeoutMs: options.timeoutMs ?? 5000,
    };

    if (typeof window !== 'undefined') {
      this.setupEventListeners();
      this.check().then(s => this.setStatus(s));
    }
  }

  private setupEventListeners(): void {
    window.addEventListener('online', () => this.setStatus('online'));
    window.addEventListener('offline', () => this.setStatus('offline'));
  }

  /**
   * Verifica conectividad real (no solo event listeners del browser)
   */
  async check(): Promise<NetworkStatus> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

      const response = await fetch(this.options.checkUrl, {
        method: 'HEAD',
        cache: 'no-cache',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return response.ok ? 'online' : 'offline';
    } catch {
      return 'offline';
    }
  }

  /**
   * Inicia polling periódico
   */
  startPolling(): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => {
      this.check().then(s => this.setStatus(s));
    }, this.options.checkIntervalMs);
  }

  /**
   * Detiene polling
   */
  stopPolling(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Obtiene estado actual
   */
  getStatus(): NetworkStatus {
    return this.status;
  }

  /**
   * Suscribe a cambios de estado
   */
  subscribe(callback: (status: NetworkStatus) => void): () => void {
    this.listeners.add(callback);
    // Notificar estado actual inmediatamente
    callback(this.status);
    return () => this.listeners.delete(callback);
  }

  private setStatus(newStatus: NetworkStatus): void {
    if (newStatus !== this.status) {
      this.status = newStatus;
      this.listeners.forEach(cb => cb(newStatus));
    }
  }

  destroy(): void {
    this.stopPolling();
    this.listeners.clear();
  }
}

/**
 * Hook para React (opcional)
 */
export function useNetworkStatus(detector: NetworkDetector): NetworkStatus {
  // This would be used in a React component
  // For now, just return the detector's current status
  return detector.getStatus();
}