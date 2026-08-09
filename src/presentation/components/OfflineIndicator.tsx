import React, { useState, useEffect, useCallback } from 'react';
import { NetworkDetector, NetworkStatus } from '../../infrastructure/persistence/offline/NetworkDetector';
import { OutboxManager } from '../../infrastructure/persistence/offline/OutboxManager';
import { SyncManager } from '../../infrastructure/persistence/offline/SyncManager';
import { playSound } from '../utils/audio';

interface OfflineIndicatorProps {
  networkDetector: NetworkDetector;
  outboxManager?: OutboxManager;
  syncManager?: SyncManager;
  compact?: boolean;
}

export function OfflineIndicator({
  networkDetector,
  outboxManager,
  syncManager,
  compact = false,
}: OfflineIndicatorProps) {
  const [status, setStatus] = useState<NetworkStatus>(networkDetector.getStatus());
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    const unsub = networkDetector.subscribe(setStatus);
    return unsub;
  }, [networkDetector]);

  // Poll pending count
  useEffect(() => {
    if (!outboxManager) return;
    const interval = setInterval(async () => {
      const pending = await outboxManager.getPending();
      setPendingCount(pending.filter(p => p.status === 'pending' || p.status === 'processing').length);
    }, 5000);
    return () => clearInterval(interval);
  }, [outboxManager]);

  // Listen to sync events
  useEffect(() => {
    if (!syncManager) return;
    const unsubStart = syncManager.on('sync:started', () => setSyncing(true));
    const unsubEnd = syncManager.on('sync:completed', (result: any) => {
      setSyncing(false);
      setLastSync(Date.now());
      if (result.synced > 0) playSound('success');
      if (result.conflicts > 0) playSound('warning');
    });
    const unsubError = syncManager.on('sync:error', () => {
      setSyncing(false);
      playSound('error');
    });
    return () => { unsubStart(); unsubEnd(); unsubError(); };
  }, [syncManager]);

  if (compact) {
    return (
      <div style={styles.compactContainer} title={getTooltip()}>
        <span style={getStatusStyle()}>{getStatusIcon()}</span>
        {pendingCount > 0 && <span style={styles.badge}>{pendingCount}</span>}
        {syncing && <span style={styles.syncSpinner} />}
      </div>
    );
  }

  return (
    <div style={styles.container} onClick={() => setShowDetails(!showDetails)}>
      <div style={styles.row}>
        <span style={getStatusStyle()}>{getStatusIcon()}</span>
        <span style={styles.label}>{getStatusText()}</span>
        {pendingCount > 0 && <span style={styles.badge}>{pendingCount} pendientes</span>}
        {syncing && <span style={styles.syncSpinner} />}
      </div>

      {showDetails && (
        <div style={styles.details}>
          <div style={styles.detailRow}>
            <span>Última sincronización:</span>
            <span>{lastSync ? new Date(lastSync).toLocaleTimeString() : 'Nunca'}</span>
          </div>
          {outboxManager && (
            <div style={styles.detailRow}>
              <span>Operaciones en cola:</span>
              <span>{pendingCount}</span>
            </div>
          )}
          <div style={styles.detailRow}>
            <span>Estado red:</span>
            <span style={{ color: status === 'online' ? '#00ff41' : '#ff4444' }}>
              {status === 'online' ? 'Conectado' : status === 'offline' ? 'Desconectado' : 'Verificando...'}
            </span>
          </div>
          {syncManager && (
            <button style={styles.syncBtn} onClick={() => syncManager!.sync()}>
              {syncing ? 'Sincronizando...' : 'Sincronizar ahora'}
            </button>
          )}
        </div>
      )}
    </div>
  );

  function getStatusIcon(): string {
    if (syncing) return '⟳';
    switch (status) {
      case 'online': return '🟢';
      case 'offline': return '🔴';
      default: return '🟡';
    }
  }

  function getStatusText(): string {
    if (syncing) return 'Sincronizando...';
    switch (status) {
      case 'online': return 'En línea';
      case 'offline': return 'Sin conexión';
      default: return 'Verificando...';
    }
  }

  function getTooltip(): string {
    let tip = getStatusText();
    if (pendingCount > 0) tip += ` · ${pendingCount} operaciones pendientes`;
    if (lastSync) tip += ` · Última sync: ${new Date(lastSync).toLocaleTimeString()}`;
    return tip;
  }

  function getStatusStyle(): React.CSSProperties {
    if (syncing) return styles.statusSyncing;
    switch (status) {
      case 'online': return styles.statusOnline;
      case 'offline': return styles.statusOffline;
      default: return styles.statusUnknown;
    }
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '4px',
    padding: '8px 12px',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: '"JetBrains Mono", monospace',
  },
  compactContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 8px',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: '4px',
    fontSize: '14px',
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  label: { fontWeight: 'bold' },
  badge: {
    background: '#ffaa00',
    color: '#000',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: 'bold',
  },
  syncSpinner: {
    display: 'inline-block',
    width: '12px',
    height: '12px',
    border: '2px solid transparent',
    borderTopColor: '#00ff41',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  details: {
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: '1px solid #2a2a2a',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    fontSize: '11px',
  },
  detailRow: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
  syncBtn: {
    marginTop: '8px',
    padding: '6px 12px',
    background: '#1a3a1a',
    border: '1px solid #00ff41',
    color: '#00ff41',
    borderRadius: '4px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
  },
  statusOnline: { color: '#00ff41' },
  statusOffline: { color: '#ff4444' },
  statusUnknown: { color: '#ffaa00' },
  statusSyncing: { color: '#4444ff' },
};