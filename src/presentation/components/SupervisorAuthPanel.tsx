import React, { useCallback, useEffect, useRef, useState } from 'react';
import { playSound } from '../utils/audio';

export interface SupervisorAuthRequest {
  supervisorId: string;
  pin: string;
}

interface SupervisorAuthPanelProps {
  actionLabel: string;
  note?: string;
  loading?: boolean;
  error?: string | null;
  onCancel?: () => void;
  onSubmit: (req: SupervisorAuthRequest) => void;
}

const PIN_MAX = 6;
const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['C', '0', '⌫'],
] as const;

/**
 * Panel de autorización de supervisor: ID + PIN numérico.
 * Usado para autorizar acciones sensibles (anulación de venta, retiro de efectivo)
 * sin diálogos nativos del navegador.
 */
export function SupervisorAuthPanel({ actionLabel, note, loading, error, onCancel, onSubmit }: SupervisorAuthPanelProps) {
  const [supervisorId, setSupervisorId] = useState('');
  const [pin, setPin] = useState('');
  const idRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    idRef.current?.focus();
  }, []);

  const press = useCallback((key: string) => {
    if (loading) return;
    playSound('keypress');
    if (key === '⌫') {
      setPin((p) => p.slice(0, -1));
    } else if (key === 'C') {
      setPin('');
    } else if (pin.length < PIN_MAX) {
      setPin((p) => p + key);
    }
  }, [loading, pin.length]);

  const submit = useCallback(() => {
    if (loading || supervisorId.trim().length === 0 || pin.length === 0) return;
    playSound('keypress');
    onSubmit({ supervisorId: supervisorId.trim(), pin });
  }, [loading, supervisorId, pin, onSubmit]);

  const canSubmit = !loading && supervisorId.trim().length > 0 && pin.length > 0;

  return (
    <div style={styles.panel} data-supervisor-auth="true">
      <div style={styles.fieldLabel}>ID DEL SUPERVISOR</div>
      <input
        ref={idRef}
        type="text"
        value={supervisorId}
        onChange={(e) => setSupervisorId(e.target.value)}
        placeholder="supervisor@pos.com"
        style={styles.idInput}
        aria-label="ID del supervisor"
        autoComplete="off"
        spellCheck={false}
        disabled={loading}
      />

      <div style={styles.fieldLabel}>PIN DEL SUPERVISOR</div>
      <div style={styles.pinDisplay} aria-label="PIN del supervisor">
        {'•'.repeat(pin.length)}
        {pin.length < PIN_MAX ? <span style={styles.pinCursor}>&nbsp;</span> : null}
      </div>
      <div style={styles.keypad} role="group" aria-label="Teclado PIN">
        {KEYS.map((row, rIdx) => (
          <div key={rIdx} style={styles.keyRow}>
            {row.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => press(key)}
                disabled={loading}
                style={key === '⌫' || key === 'C' ? styles.keyFunc : styles.key}
                aria-label={key === '⌫' ? 'Borrar dígito' : key === 'C' ? 'Limpiar PIN' : key}
              >
                {key}
              </button>
            ))}
          </div>
        ))}
      </div>

      {note && <div style={styles.note}>{note}</div>}
      {error && (
        <div style={styles.error} role="alert">{error}</div>
      )}

      <div style={styles.actions}>
        <button type="button" onClick={onCancel} style={styles.btnCancel} disabled={loading} aria-label="Cancelar">
          CANCELAR
        </button>
        <button
          type="button"
          onClick={submit}
          style={styles.btnSubmit}
          disabled={!canSubmit}
          aria-label={actionLabel}
        >
          {loading ? 'AUTORIZANDO...' : actionLabel}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { textAlign: 'center' },
  fieldLabel: { color: '#888', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '6px', marginTop: '14px' },
  idInput: {
    width: '100%',
    padding: '12px 16px',
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: '15px',
    borderRadius: '6px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  pinDisplay: {
    padding: '14px',
    background: '#111',
    border: '2px solid #333',
    color: '#00ff41',
    fontFamily: 'monospace',
    fontSize: '28px',
    letterSpacing: '10px',
    borderRadius: '8px',
    textAlign: 'center',
    minHeight: '56px',
    marginBottom: '12px',
  },
  pinCursor: { opacity: 0.3 },
  keypad: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' },
  keyRow: { display: 'flex', gap: '8px', justifyContent: 'center' },
  key: {
    width: '72px',
    height: '58px',
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#fff',
    fontFamily: 'monospace',
    fontSize: '22px',
    fontWeight: 'bold',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  keyFunc: {
    width: '72px',
    height: '58px',
    background: '#3a2a00',
    border: '1px solid #553300',
    color: '#ffaa00',
    fontFamily: 'monospace',
    fontSize: '20px',
    fontWeight: 'bold',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  note: { color: '#aaa', fontSize: '12px', marginBottom: '12px' },
  error: {
    marginBottom: '12px',
    padding: '8px 12px',
    background: '#3a0000',
    border: '1px solid #ff4444',
    color: '#ff8888',
    borderRadius: '6px',
    fontSize: '12px',
  },
  actions: { display: 'flex', gap: '12px', justifyContent: 'center' },
  btnCancel: {
    padding: '12px 24px',
    fontSize: '13px',
    fontWeight: 'bold',
    background: '#1a1a1a',
    color: '#888',
    border: '1px solid #333',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnSubmit: {
    padding: '12px 28px',
    fontSize: '13px',
    fontWeight: 'bold',
    background: '#0a2a1a',
    color: '#00ff41',
    border: '1px solid #00ff41',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
