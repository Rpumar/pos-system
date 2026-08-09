import { useEffect, useCallback, useRef } from 'react';
import { ScannerDetector } from '../services/ScannerDetector';

export interface CheckoutKeyboardHandlers {
  onScan: (barcode: string) => void;
  onPay: () => void;        // F5
  onSearch: () => void;     // F2
  onReports: () => void;    // F3 - Informes
  onCancel: () => void;     // ESC
  onQuantityUp: () => void; // +
  onQuantityDown: () => void; // -
  onCloseRegister: () => void; // F12
  onVoidSale: () => void;   // F8 (requiere PIN supervisor)
  onProducts: () => void;   // F4 - Gestión de productos
  onRetiro: () => void;     // F9 - Retiro de efectivo
  onDeposito: () => void;   // F10 - Depósito de efectivo
}

/**
 * Captura eventos de teclado a nivel de window para garantizar que
 * F1-F12 siempre funcionen, incluso cuando el foco está en un input.
 *
 * La única excepción es el buscador manual (F2): cuando ese input
 * tiene foco (data-free-text="true"), los caracteres normales le
 * pertenecen — pero F1-F12 y ESC siguen siendo globales.
 */
export function useCheckoutKeyboard(
  handlers: CheckoutKeyboardHandlers,
  enabled: boolean
): void {
  const detector = useRef(new ScannerDetector());
  // Ref estable para handlers: evita re-registrar el listener en cada
  // render cuando un handler cambia de referencia pero no de lógica.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      const target = e.target as HTMLElement & { dataset: { freeText?: string } };
      const isFreeText = target.dataset.freeText === 'true';

      // Solo handlers sin argumentos — onScan queda excluido a propósito.
      type NoArgHandler = Exclude<keyof CheckoutKeyboardHandlers, 'onScan'>;
      const fnKeys: Record<string, NoArgHandler> = {
        F2: 'onSearch',
        F3: 'onReports',
        F4: 'onProducts',
        F5: 'onPay',
        F8: 'onVoidSale',
        F9: 'onRetiro',
        F10: 'onDeposito',
        F12: 'onCloseRegister',
        Escape: 'onCancel',
      };

      const mappedKey = fnKeys[e.key];
      if (mappedKey) {
        e.preventDefault();
        if (e.key === 'Escape') detector.current.reset();
        (handlersRef.current[mappedKey] as () => void)();
        return;
      }

      // +/- para cantidad: solo cuando el foco NO está en un input libre.
      if (!isFreeText) {
        if (e.key === '+') { e.preventDefault(); handlersRef.current.onQuantityUp(); return; }
        if (e.key === '-') { e.preventDefault(); handlersRef.current.onQuantityDown(); return; }
      }

      // Flujo de scanner: acumula caracteres fuera del buscador manual.
      if (!isFreeText) {
        if (e.key === 'Enter') {
          const code = detector.current.complete();
          if (code) handlersRef.current.onScan(code);
        } else if (e.key.length === 1) {
          detector.current.feed(e.key, performance.now());
        }
      }
    },
    [enabled]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);
}
