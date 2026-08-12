import React, { useState, useCallback, useEffect } from 'react';
import { playSound } from '../utils/audio';

interface PrinterSettingsViewProps {
  onBack: () => void;
}

interface PortInfo {
  port: string;
  manufacturer?: string;
  pnpId?: string;
}

interface PrinterConfig {
  portPath: string;
  baudRate: number;
  paperWidth: '58' | '80';
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200];

const STATUS_LABELS: Record<string, { text: string; color: string; bg: string; border: string }> = {
  READY: { text: 'LISTA', color: '#00ff41', bg: '#0a2a1a', border: '#00ff41' },
  OUT_OF_PAPER: { text: 'SIN PAPEL', color: '#ffaa00', bg: '#3a2a00', border: '#ffaa00' },
  COVER_OPEN: { text: 'TAPA ABIERTA', color: '#ffaa00', bg: '#3a2a00', border: '#ffaa00' },
  OFFLINE: { text: 'OFFLINE', color: '#ff4444', bg: '#3a0000', border: '#ff4444' },
  ERROR: { text: 'ERROR', color: '#ff4444', bg: '#3a0000', border: '#ff4444' },
  UNKNOWN: { text: 'DESCONOCIDO', color: '#888', bg: '#1a1a1a', border: '#333' },
};

export function PrinterSettingsView({ onBack }: PrinterSettingsViewProps) {
  const api = typeof window !== 'undefined' ? window.electronAPI?.hardware?.printer : undefined;
  const bridgeAvailable = !!api;

  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [portPath, setPortPath] = useState('');
  const [baudRate, setBaudRate] = useState(9600);
  const [paperWidth, setPaperWidth] = useState<'58' | '80'>('80');
  const [status, setStatus] = useState('UNKNOWN');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);

  const refreshPorts = useCallback(async () => {
    if (!api) return;
    setDetecting(true);
    try {
      const found = await api.listPorts();
      setPorts(found);
      if (found.length === 0) setSuccess('No se detectaron puertos serie. Conecte la impresora y vuelva a detectar.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error detectando puertos');
      playSound('error');
    } finally {
      setDetecting(false);
    }
  }, [api]);

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    try {
      const { status: s, error: err } = await api.status();
      setStatus(s);
      setStatusError(err ?? null);
    } catch {
      setStatus('ERROR');
      setStatusError('No se pudo consultar el estado');
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    (async () => {
      try {
        const [found, config] = await Promise.all([api.listPorts(), api.getConfig()]);
        if (cancelled) return;
        setPorts(found);
        if (config) {
          setPortPath(config.portPath);
          setBaudRate(config.baudRate);
          setPaperWidth(config.paperWidth);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error cargando configuración');
      }
    })();
    void refreshStatus();
    return () => { cancelled = true; };
  }, [api, refreshStatus]);

  const handleSave = useCallback(async () => {
    if (!api) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    playSound('keypress');
    try {
      const config = await api.setConfig({ portPath, baudRate, paperWidth });
      setPortPath(config.portPath);
      setBaudRate(config.baudRate);
      setPaperWidth(config.paperWidth);
      setSuccess(`Configuración guardada: ${config.portPath || '(sin puerto)'} @ ${config.baudRate} baud, papel ${config.paperWidth}mm`);
      playSound('success');
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando configuración');
      playSound('error');
    } finally {
      setSaving(false);
    }
  }, [api, portPath, baudRate, paperWidth, refreshStatus]);

  const handleTestPrint = useCallback(async () => {
    if (!api) return;
    setPrinting(true);
    setError(null);
    setSuccess(null);
    playSound('keypress');
    try {
      await api.test(
        'PRUEBA DE IMPRESORA\n====================\nPOS System v0.1.2\nAcentos: á é í ó ú ñ\n$1.234,56 | 12,5 kg\n====================\nOK'
      );
      setSuccess('Prueba de impresión enviada correctamente');
      playSound('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error imprimiendo prueba');
      playSound('error');
    } finally {
      setPrinting(false);
    }
  }, [api]);

  const handleOpenDrawer = useCallback(async () => {
    if (!api) return;
    setError(null);
    setSuccess(null);
    playSound('keypress');
    try {
      await api.openCashDrawer();
      setSuccess('Pulso de cajón enviado');
      playSound('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error abriendo el cajón');
      playSound('error');
    }
  }, [api]);

  const statusStyle = STATUS_LABELS[status] ?? STATUS_LABELS.UNKNOWN;
  const hasConfiguredPort = portPath.length > 0;

  return (
    <div style={styles.container} role="application" aria-label="Configuración de impresora">
      <header style={styles.header}>
        <button type="button" onClick={onBack} style={styles.backBtn} aria-label="Volver al checkout">
          ← Volver
        </button>
        <h1 style={styles.title}>CONFIGURACIÓN DE IMPRESORA</h1>
        <div style={styles.headerActions}>
          <button type="button" onClick={refreshStatus} style={styles.btnSecondary} aria-label="Actualizar estado">
            ⟳ Estado
          </button>
        </div>
      </header>

      {!bridgeAvailable && (
        <div style={styles.warnMsg} role="alert">
          La configuración de impresora solo está disponible en la aplicación de escritorio (electron). En navegador los periféricos están desactivados.
        </div>
      )}

      {(error || success) && (
        <div style={styles.messages}>
          {error && <div style={styles.errorMsg} role="alert" onClick={() => setError(null)}>{error} <span style={styles.msgClose}>✕</span></div>}
          {success && <div style={styles.successMsg} role="status" onClick={() => setSuccess(null)}>{success} <span style={styles.msgClose}>✕</span></div>}
        </div>
      )}

      <div style={styles.content}>
        {/* ── Estado actual ── */}
        <section style={styles.card} aria-label="Estado de la impresora">
          <h2 style={styles.sectionTitle}>ESTADO</h2>
          <div style={{ ...styles.statusBox, color: statusStyle.color, background: statusStyle.bg, border: `1px solid ${statusStyle.border}` }}>
            <span style={styles.statusDot} aria-hidden="true" />
            {statusStyle.text}
          </div>
          {statusError && <p style={styles.hint}>Detalle: {statusError}</p>}
          <p style={styles.hint}>
            El estado se consulta en vivo. Sin impresora conectada, el estado será OFFLINE.
          </p>
        </section>

        {/* ── Puertos ── */}
        <section style={styles.card} aria-label="Puerto serie">
          <h2 style={styles.sectionTitle}>PUERTO SERIE</h2>
          <div style={styles.fieldRow}>
            <select
              value={portPath}
              onChange={(e) => setPortPath(e.target.value)}
              style={styles.select}
              aria-label="Puerto serie"
              disabled={!bridgeAvailable || detecting}
            >
              <option value="">— Seleccionar puerto —</option>
              {ports.map((p) => (
                <option key={p.port} value={p.port}>
                  {p.port}{p.manufacturer ? ` (${p.manufacturer})` : ''}
                </option>
              ))}
            </select>
            <button type="button" onClick={refreshPorts} style={styles.btnSecondary} disabled={!bridgeAvailable || detecting} aria-label="Detectar puertos">
              {detecting ? 'Detectando...' : '⟳ Detectar'}
            </button>
          </div>
          {ports.length === 0 && !detecting && (
            <p style={styles.hint}>No se encontraron puertos. Conecte la impresora por USB/serie y presione "Detectar".</p>
          )}
          {hasConfiguredPort && !ports.some((p) => p.port === portPath) && (
            <p style={styles.warnInline}>El puerto configurado ({portPath}) no está presente en este momento.</p>
          )}
        </section>

        {/* ── Parámetros ── */}
        <section style={styles.card} aria-label="Parámetros de impresión">
          <h2 style={styles.sectionTitle}>PARÁMETROS</h2>
          <div style={styles.fieldRow}>
            <label style={styles.label} htmlFor="baudRate">Velocidad (baud)</label>
            <select
              id="baudRate"
              value={baudRate}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              style={styles.select}
              disabled={!bridgeAvailable}
              aria-label="Velocidad de baudios"
            >
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div style={styles.fieldRow}>
            <span style={styles.label}>Ancho de papel</span>
            <div style={styles.toggleGroup}>
              <button
                type="button"
                style={paperWidth === '58' ? styles.toggleActive : styles.toggleBtn}
                onClick={() => setPaperWidth('58')}
                disabled={!bridgeAvailable}
                aria-pressed={paperWidth === '58'}
              >
                58 mm
              </button>
              <button
                type="button"
                style={paperWidth === '80' ? styles.toggleActive80 : styles.toggleBtn}
                onClick={() => setPaperWidth('80')}
                disabled={!bridgeAvailable}
                aria-pressed={paperWidth === '80'}
              >
                80 mm
              </button>
            </div>
          </div>
          <p style={styles.hint}>
            {paperWidth === '58' ? '32 caracteres por línea (impresora de ticket angosto).' : '48 caracteres por línea (estándar de caja).'}
          </p>
        </section>

        {/* ── Acciones ── */}
        <section style={styles.card} aria-label="Acciones">
          <h2 style={styles.sectionTitle}>ACCIONES</h2>
          <div style={styles.actionRow}>
            <button
              type="button"
              onClick={handleSave}
              style={styles.btnPrimary}
              disabled={!bridgeAvailable || saving}
              aria-label={saving ? 'Guardando...' : 'Guardar configuración'}
            >
              {saving ? 'GUARDANDO...' : 'GUARDAR'}
            </button>
            <button
              type="button"
              onClick={handleTestPrint}
              style={styles.btnTest}
              disabled={!bridgeAvailable || printing || !hasConfiguredPort}
              aria-label={printing ? 'Imprimiendo prueba...' : 'Imprimir prueba'}
              title={!hasConfiguredPort ? 'Seleccione un puerto antes de imprimir' : undefined}
            >
              {printing ? 'IMPRIMIENDO...' : '🖨 IMPRIMIR PRUEBA'}
            </button>
            <button
              type="button"
              onClick={handleOpenDrawer}
              style={styles.btnDrawer}
              disabled={!bridgeAvailable || !hasConfiguredPort}
              aria-label="Abrir cajón de dinero"
              title={!hasConfiguredPort ? 'Seleccione un puerto antes de abrir el cajón' : undefined}
            >
              💵 ABRIR CAJÓN
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#0d0d0d',
    color: '#fff',
    fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    gap: '12px',
    flexWrap: 'wrap',
  },
  backBtn: {
    padding: '8px 14px',
    background: '#1a1a1a',
    border: '1px solid #4444ff',
    color: '#4444ff',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontFamily: 'inherit',
  },
  title: {
    margin: 0,
    color: '#00ff41',
    fontSize: '16px',
    letterSpacing: '2px',
    textTransform: 'uppercase',
  },
  headerActions: { display: 'flex', gap: '8px' },
  messages: { padding: '0 16px' },
  errorMsg: {
    margin: '8px 0',
    padding: '10px 14px',
    background: '#3a0000',
    border: '1px solid #ff4444',
    color: '#ff8888',
    borderRadius: '6px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  successMsg: {
    margin: '8px 0',
    padding: '10px 14px',
    background: '#0a2a1a',
    border: '1px solid #00ff41',
    color: '#7dffa0',
    borderRadius: '6px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  warnMsg: {
    margin: '8px 16px',
    padding: '10px 14px',
    background: '#3a2a00',
    border: '1px solid #ffaa00',
    color: '#ffcc66',
    borderRadius: '6px',
    fontSize: '13px',
  },
  warnInline: {
    margin: '8px 0 0',
    color: '#ffaa00',
    fontSize: '12px',
  },
  msgClose: { float: 'right', fontWeight: 'bold' },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '720px',
    width: '100%',
    alignSelf: 'center',
    boxSizing: 'border-box',
  },
  card: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: '10px',
    padding: '20px',
  },
  sectionTitle: {
    margin: '0 0 14px',
    fontSize: '12px',
    color: '#00ff41',
    letterSpacing: '2px',
    textTransform: 'uppercase',
  },
  statusBox: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 18px',
    borderRadius: '6px',
    fontWeight: 'bold',
    fontSize: '14px',
    letterSpacing: '1px',
  },
  statusDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: 'currentColor',
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '14px',
    flexWrap: 'wrap',
  },
  label: {
    color: '#888',
    fontSize: '13px',
    minWidth: '160px',
  },
  select: {
    flex: 1,
    minWidth: '220px',
    padding: '10px 12px',
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: '14px',
    borderRadius: '6px',
  },
  toggleGroup: { display: 'flex', gap: '10px' },
  toggleBtn: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 'bold',
    background: '#1a1a1a',
    color: '#888',
    border: '1px solid #333',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  toggleActive: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 'bold',
    background: '#3a2a00',
    color: '#ffaa00',
    border: '1px solid #ffaa00',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  toggleActive80: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 'bold',
    background: '#0a2a1a',
    color: '#00ff41',
    border: '1px solid #00ff41',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  hint: { color: '#666', fontSize: '12px', margin: '8px 0 0' },
  actionRow: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
  },
  btnPrimary: {
    padding: '14px 28px',
    fontSize: '14px',
    fontWeight: 'bold',
    background: '#0a2a1a',
    color: '#00ff41',
    border: '1px solid #00ff41',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnTest: {
    padding: '14px 28px',
    fontSize: '14px',
    fontWeight: 'bold',
    background: '#1a1a3a',
    color: '#4444ff',
    border: '1px solid #4444ff',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnDrawer: {
    padding: '14px 28px',
    fontSize: '14px',
    fontWeight: 'bold',
    background: '#3a2a00',
    color: '#ffaa00',
    border: '1px solid #ffaa00',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnSecondary: {
    padding: '10px 14px',
    fontSize: '12px',
    fontWeight: 'bold',
    background: '#1a1a1a',
    color: '#888',
    border: '1px solid #333',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
