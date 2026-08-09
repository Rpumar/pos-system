import React, { useCallback, useEffect, useRef } from 'react';
import { playSound } from '../utils/audio';

interface NumericKeypadProps {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onEscape: () => void;
  onBackspace: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', '⌫'],
] as const;

export function NumericKeypad({
  value,
  onChange,
  onEnter,
  onEscape,
  onBackspace,
  placeholder = 'Código de barras...',
  disabled = false,
  autoFocus = false,
}: NumericKeypadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleKey = useCallback((key: string) => {
    if (disabled) return;
    playSound('keypress');

    if (key === '⌫') {
      onBackspace();
    } else {
      onChange(value + key);
    }
  }, [disabled, value, onChange, onBackspace]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      onBackspace();
    } else if (/^[\d.]$/.test(e.key)) {
      e.preventDefault();
      handleKey(e.key);
    }
  }, [onEnter, onEscape, onBackspace, handleKey]);

  return (
    <div style={styles.container}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        style={styles.input}
        aria-label="Entrada numérica"
        spellCheck={false}
        autoComplete="off"
      />
      <div style={styles.keypad} role="application" aria-label="Teclado numérico">
        {KEYS.map((row, rowIdx) => (
          <div key={rowIdx} style={styles.row}>
            {row.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => handleKey(key)}
                disabled={disabled}
                style={key === '⌫' ? styles.keyBackspace : styles.key}
                aria-label={key === '⌫' ? 'Borrar' : key}
              >
                {key === '⌫' ? '⌫' : key}
              </button>
            ))}
          </div>
        ))}
        <button
          type="button"
          onClick={onEnter}
          disabled={disabled || value.length === 0}
          style={styles.keyEnter}
          aria-label="Confirmar"
        >
          ENTER
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '360px' },
  input: {
    padding: '16px',
    background: '#111',
    border: '2px solid #333',
    color: '#fff',
    fontFamily: 'monospace',
    fontSize: '24px',
    borderRadius: '8px',
    textAlign: 'center',
    outline: 'none',
  },
  keypad: { display: 'flex', flexDirection: 'column', gap: '8px' },
  row: { display: 'flex', gap: '8px', justifyContent: 'center' },
  key: {
    width: '80px',
    height: '64px',
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#fff',
    fontFamily: 'monospace',
    fontSize: '24px',
    fontWeight: 'bold',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.05s',
  },
  keyBackspace: {
    width: '80px',
    height: '64px',
    background: '#3a1a1a',
    border: '1px solid #553333',
    color: '#ff8888',
    fontFamily: 'monospace',
    fontSize: '20px',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  keyEnter: {
    width: '100%',
    height: '56px',
    marginTop: '8px',
    background: '#1a3a1a',
    border: '1px solid #00ff41',
    color: '#00ff41',
    fontFamily: 'monospace',
    fontSize: '18px',
    fontWeight: 'bold',
    borderRadius: '8px',
    cursor: 'pointer',
  },
};