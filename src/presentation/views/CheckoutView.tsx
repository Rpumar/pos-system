import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useCart } from '../hooks/useCart';
import { useCheckoutKeyboard } from '../hooks/useCheckoutKeyboard';
import { AddProductToCartUseCase } from '../../application/use-cases/AddProductToCartUseCase';
import { Cart, CartItem } from '../../domain/entities/Cart';
import { OfflineIndicator } from '../components/OfflineIndicator';
import { NumericKeypad } from '../components/NumericKeypad';
import { SupervisorAuthPanel, SupervisorAuthRequest } from '../components/SupervisorAuthPanel';
import { playSound, preloadAudio } from '../utils/audio';
import { PeripheralEventBus } from '../hardware/PeripheralEventBus';
import { IThermalPrinter } from '../../application/ports/IPeripherals';
import { NetworkDetector, OutboxManager, SyncManager } from '../../infrastructure/persistence/offline';

interface CheckoutViewProps {
  addProductUseCase: AddProductToCartUseCase;
  shiftId: string;
  onPay: (method: 'CASH' | 'CARD', cart: Cart) => void;
  onCloseRegister: (counted: number) => Promise<void>;
  onVoidSale: (input: { reason: string; supervisorId: string; supervisorPin: string }) => Promise<void>;
  onProducts: () => void;
  onReports: () => void;
  onCashMovement: (type: 'WITHDRAWAL' | 'DEPOSIT', amount: number, reason: string, supervisor?: { supervisorId: string; pin: string }) => Promise<void>;
  // Periféricos
  eventBus?: PeripheralEventBus;
  printer?: IThermalPrinter;
  // Offline-first
  networkDetector?: NetworkDetector;
  outboxManager?: OutboxManager;
  syncManager?: SyncManager;
}

interface PaymentState {
  loading: boolean;
  method: 'CASH' | 'CARD' | null;
}

interface PeripheralStatus {
  printer: 'READY' | 'OUT_OF_PAPER' | 'OFFLINE' | 'COVER_OPEN' | 'ERROR' | 'UNKNOWN';
  terminal: 'IDLE' | 'PROCESSING' | 'APPROVED' | 'REJECTED' | 'TIMEOUT' | 'DISCONNECTED' | 'UNKNOWN';
  scanner: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
}

export function CheckoutView({
  addProductUseCase,
  shiftId,
  onPay,
  onCloseRegister,
  onVoidSale,
  onProducts,
  onReports,
  onCashMovement,
  eventBus,
  printer,
  networkDetector,
  outboxManager,
  syncManager,
}: CheckoutViewProps) {
  const { items, total, cartRef, error, scanProduct, updateQuantity, removeItem, clearError, clear } =
    useCart(addProductUseCase);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showPayModal, setShowPayModal] = useState(false);
  const [paymentState, setPaymentState] = useState<PaymentState>({ loading: false, method: null });
  const [showKeypad, setShowKeypad] = useState(false);
  const [keypadValue, setKeypadValue] = useState('');
  const [closeRegisterLoading, setCloseRegisterLoading] = useState(false);
  const [voidSaleLoading, setVoidSaleLoading] = useState(false);
  const [showCashModal, setShowCashModal] = useState(false);
  const [cashType, setCashType] = useState<'WITHDRAWAL' | 'DEPOSIT'>('WITHDRAWAL');
  const [cashAmount, setCashAmount] = useState('');
  const [cashReason, setCashReason] = useState('');
  const [cashLoading, setCashLoading] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  const [cashStep, setCashStep] = useState<'FORM' | 'AUTH'>('FORM');
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidStep, setVoidStep] = useState<'FORM' | 'AUTH'>('FORM');
  const [voidError, setVoidError] = useState<string | null>(null);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closeCounted, setCloseCounted] = useState('');
  const [closeError, setCloseError] = useState<string | null>(null);
  const [peripheralStatus, setPeripheralStatus] = useState<PeripheralStatus>({
    printer: 'UNKNOWN',
    terminal: 'UNKNOWN',
    scanner: 'UNKNOWN',
  });

  const keypadInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const totalRef = useRef(total);
  totalRef.current = total;

  // Subscribe to peripheral events
  useEffect(() => {
    const unsubPrinter = eventBus?.on?.('printer:ready', () => setPeripheralStatus(s => ({ ...s, printer: 'READY' })));
    const unsubPaper = eventBus?.on?.('printer:out-of-paper', () => setPeripheralStatus(s => ({ ...s, printer: 'OUT_OF_PAPER' })));
    const unsubCover = eventBus?.on?.('printer:cover-open', () => setPeripheralStatus(s => ({ ...s, printer: 'COVER_OPEN' })));
    const unsubError = eventBus?.on?.('printer:error', () => setPeripheralStatus(s => ({ ...s, printer: 'ERROR' })));
    const unsubTermOpen = eventBus?.on?.('terminal:circuit-open', () => setPeripheralStatus(s => ({ ...s, terminal: 'DISCONNECTED' })));
    const unsubTermClose = eventBus?.on?.('terminal:reconnected', () => setPeripheralStatus(s => ({ ...s, terminal: 'IDLE' })));
    const unsubScanConn = eventBus?.on?.('scanner:connected', () => setPeripheralStatus(s => ({ ...s, scanner: 'CONNECTED' })));
    const unsubScanDisc = eventBus?.on?.('scanner:disconnected', () => setPeripheralStatus(s => ({ ...s, scanner: 'DISCONNECTED' })));

    return () => {
      unsubPrinter?.();
      unsubPaper?.();
      unsubCover?.();
      unsubError?.();
      unsubTermOpen?.();
      unsubTermClose?.();
      unsubScanConn?.();
      unsubScanDisc?.();
    };
  }, [eventBus]);

  // Poll del estado de impresora: refleja conexión/sin papel al montar y en vivo.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!printer) return;
      try {
        const status = await printer.getStatus();
        if (cancelled) return;
        setPeripheralStatus((s) => ({ ...s, printer: status }));
      } catch {
        if (!cancelled) setPeripheralStatus((s) => ({ ...s, printer: 'ERROR' }));
      }
    };
    void check();
    const interval = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [printer]);

  // Prime audio on first interaction
  useEffect(() => {
    const handleFirstInteraction = () => {
      preloadAudio();
      document.removeEventListener('click', handleFirstInteraction);
      document.removeEventListener('keydown', handleFirstInteraction);
    };
    document.addEventListener('click', handleFirstInteraction);
    document.addEventListener('keydown', handleFirstInteraction);
    return () => {
      document.removeEventListener('click', handleFirstInteraction);
      document.removeEventListener('keydown', handleFirstInteraction);
    };
  }, []);

  // Selected item for keyboard navigation
  const selectedItem: CartItem | undefined = items[selectedIdx];

  // Keyboard handlers
  useCheckoutKeyboard(
    {
      onScan: useCallback(async (barcode: string) => {
        await scanProduct(barcode);
        if (!error) playSound('scan');
      }, [scanProduct, error]),
      onPay: useCallback(() => setShowPayModal(true), []),
      onSearch: useCallback(() => {
        searchInputRef.current?.focus();
        setShowKeypad(true);
      }, []),
      onCancel: useCallback(() => {
        setShowPayModal(false);
        setShowKeypad(false);
        setKeypadValue('');
        clearError();
      }, [clearError]),
      onQuantityUp: useCallback(() => {
        if (selectedItem) updateQuantity(selectedItem.productId, 1);
      }, [selectedItem, updateQuantity]),
      onQuantityDown: useCallback(() => {
        if (selectedItem) updateQuantity(selectedItem.productId, -1);
      }, [selectedItem, updateQuantity]),
      onCloseRegister: useCallback(() => {
        if (closeRegisterLoading) return;
        playSound('keypress');
        setCloseCounted('');
        setCloseError(null);
        setShowCloseModal(true);
      }, [closeRegisterLoading]),
      onVoidSale: useCallback(() => {
        playSound('warning');
        setVoidError(null);
        setVoidReason('');
        setVoidStep('FORM');
        setShowVoidModal(true);
      }, []),
      onProducts: useCallback(() => {
        playSound('keypress');
        onProducts();
      }, [onProducts]),
      onReports: useCallback(() => {
        playSound('keypress');
        onReports();
      }, [onReports]),
      onRetiro: useCallback(() => {
        setCashType('WITHDRAWAL');
        setCashAmount('');
        setCashReason('');
        setCashError(null);
        setCashStep('FORM');
        setShowCashModal(true);
      }, []),
      onDeposito: useCallback(() => {
        setCashType('DEPOSIT');
        setCashAmount('');
        setCashReason('');
        setCashError(null);
        setCashStep('FORM');
        setShowCashModal(true);
      }, []),
    },
    !showPayModal && !showKeypad && !showCashModal && !showVoidModal && !showCloseModal
  );

  // Keypad handlers
  const handleKeypadEnter = useCallback(async () => {
    if (keypadValue.length >= 6) {
      await scanProduct(keypadValue);
      if (!error) playSound('scan');
      setKeypadValue('');
    }
  }, [keypadValue, scanProduct, error]);

  const handleKeypadEscape = useCallback(() => {
    setShowKeypad(false);
    setKeypadValue('');
    clearError();
  }, [clearError]);

  const handleKeypadBackspace = useCallback(() => {
    setKeypadValue((v) => v.slice(0, -1));
  }, []);

  // Payment handlers
  const handlePayCash = useCallback(async () => {
    setPaymentState({ loading: true, method: 'CASH' });
    playSound('keypress');
    try {
      await onPay('CASH', cartRef.current);
      playSound('success');
      setShowPayModal(false);
      clear();
    } finally {
      setPaymentState({ loading: false, method: null });
    }
  }, [onPay, cartRef, clear]);

  const handlePayCard = useCallback(async () => {
    setPaymentState({ loading: true, method: 'CARD' });
    playSound('keypress');
    try {
      await onPay('CARD', cartRef.current);
      playSound('success');
      setShowPayModal(false);
      clear();
    } finally {
      setPaymentState({ loading: false, method: null });
    }
  }, [onPay, cartRef, clear]);

  // Cash movement handlers
  const doCashSubmit = useCallback(async (amount: number, reason: string, supervisor?: SupervisorAuthRequest) => {
    setCashLoading(true);
    setCashError(null);
    playSound('keypress');
    try {
      await onCashMovement(cashType, amount, reason, supervisor);
      playSound('success');
      setShowCashModal(false);
      setCashStep('FORM');
      setCashAmount('');
      setCashReason('');
      setCashType('WITHDRAWAL');
    } catch (err) {
      setCashError(err instanceof Error ? err.message : 'Error al registrar movimiento');
    } finally {
      setCashLoading(false);
    }
  }, [cashType, onCashMovement]);

  const handleCashConfirm = useCallback(() => {
    const amount = parseFloat(cashAmount.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      setCashError('Ingrese un monto válido');
      return;
    }
    setCashError(null);
    if (cashType === 'WITHDRAWAL') {
      setCashStep('AUTH');
    } else {
      void doCashSubmit(amount, cashReason.trim());
    }
  }, [cashAmount, cashReason, cashType, doCashSubmit]);

  const handleCashAuthorize = useCallback((req: SupervisorAuthRequest) => {
    const amount = parseFloat(cashAmount.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      setCashError('Ingrese un monto válido');
      setCashStep('FORM');
      return;
    }
    void doCashSubmit(amount, cashReason.trim(), req);
  }, [cashAmount, cashReason, doCashSubmit]);

  // Void sale handlers
  const handleVoidConfirm = useCallback(() => {
    setVoidError(null);
    if (!voidReason.trim()) {
      setVoidError('Ingrese el motivo de la anulación');
      return;
    }
    setVoidStep('AUTH');
  }, [voidReason]);

  const handleVoidAuthorize = useCallback(async (req: SupervisorAuthRequest) => {
    if (voidSaleLoading) return;
    setVoidSaleLoading(true);
    setVoidError(null);
    playSound('keypress');
    try {
      await onVoidSale({
        reason: voidReason.trim() || 'Sin motivo especificado',
        supervisorId: req.supervisorId,
        supervisorPin: req.pin,
      });
      playSound('success');
      setShowVoidModal(false);
      setVoidStep('FORM');
      setVoidReason('');
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : 'Error al anular la venta');
    } finally {
      setVoidSaleLoading(false);
    }
  }, [voidReason, voidSaleLoading, onVoidSale]);

  const closeCashModal = useCallback(() => {
    if (cashLoading) return;
    setShowCashModal(false);
    setCashStep('FORM');
    setCashError(null);
  }, [cashLoading]);

  const closeVoidModal = useCallback(() => {
    if (voidSaleLoading) return;
    setShowVoidModal(false);
    setVoidStep('FORM');
    setVoidError(null);
  }, [voidSaleLoading]);

  const handleCloseRegisterConfirm = useCallback(async () => {
    const counted = parseFloat((closeCounted || '').replace(',', '.'));
    if (!Number.isFinite(counted) || counted <= 0) {
      setCloseError('Ingrese el efectivo contado correctamente');
      return;
    }
    if (closeRegisterLoading) return;
    setCloseRegisterLoading(true);
    setCloseError(null);
    playSound('keypress');
    try {
      await onCloseRegister(counted);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Error al cerrar el turno');
    } finally {
      setCloseRegisterLoading(false);
    }
  }, [closeCounted, closeRegisterLoading, onCloseRegister]);

  const closeCloseModal = useCallback(() => {
    if (closeRegisterLoading) return;
    setShowCloseModal(false);
    setCloseError(null);
  }, [closeRegisterLoading]);

  // Responsive breakpoints
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const isTablet = typeof window !== 'undefined' && window.innerWidth >= 768 && window.innerWidth < 1200;

  return (
    <div style={styles.container} role="application" aria-label="Punto de venta">
      {/* ── TOP BAR ── */}
      <header style={styles.topBar} role="banner">
        <div style={styles.topBarLeft}>
          <span style={styles.shiftBadge}>Turno: {shiftId}</span>
          {isMobile && (
            <button
              type="button"
              onClick={() => setShowKeypad(true)}
              style={styles.mobileKeypadToggle}
              aria-label="Abrir teclado numérico"
            >
              ⌨
            </button>
          )}
        </div>
        <nav style={styles.shortcuts} aria-label="Atajos de teclado">
          <kbd>F2</kbd> Buscar &nbsp;
          <kbd>F3</kbd> Informes &nbsp;
          <kbd>F4</kbd> Productos &nbsp;
          <kbd>F5</kbd> Cobrar &nbsp;
          <kbd>+/−</kbd> Cant. &nbsp;
          <kbd>F8</kbd> Anular &nbsp;
          <kbd>F12</kbd> Cierre
        </nav>
        <div style={styles.peripheralStatus} aria-label="Estado de periféricos">
          <PeripheralIndicator label="🖨" status={peripheralStatus.printer} />
          <PeripheralIndicator label="💳" status={peripheralStatus.terminal} />
          <PeripheralIndicator label="📷" status={peripheralStatus.scanner} />
          {networkDetector && (
            <OfflineIndicator
              networkDetector={networkDetector}
              outboxManager={outboxManager}
              syncManager={syncManager}
              compact={true}
            />
          )}
        </div>
      </header>

      {/* ── SEARCH / BARCODE INPUT ── */}
      <div style={styles.searchWrapper}>
        <input
          ref={searchInputRef}
          data-free-text="true"
          placeholder="Buscar producto (F2) o escanear código..."
          style={styles.searchInput}
          onChange={async (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = e.target.value.trim();
            if (val.length >= 6) {
              await scanProduct(val);
              if (!error) playSound('scan');
              e.target.value = '';
            }
          }}
          onFocus={() => setShowKeypad(true)}
          aria-label="Buscar o escanear producto"
          autoComplete="off"
          spellCheck={false}
        />
        {showKeypad && !isMobile && (
          <NumericKeypad
            value={keypadValue}
            onChange={setKeypadValue}
            onEnter={handleKeypadEnter}
            onEscape={handleKeypadEscape}
            onBackspace={handleKeypadBackspace}
            placeholder="Código de barras..."
            autoFocus={true}
          />
        )}
      </div>

      {/* ── ERROR BANNER ── */}
      {error && (
        <div style={styles.errorBanner} role="alert" aria-live="assertive">
          {error.type === 'NOT_FOUND' && `⚠ Producto no encontrado: ${error.barcode}`}
          {error.type === 'INSUFFICIENT_STOCK' && `⚠ Stock insuficiente para ${error.sku} (disponible: ${error.available})`}
          {error.type === 'UNKNOWN' && '⚠ Error inesperado'}
          <button
            type="button"
            onClick={clearError}
            style={styles.errorClose}
            aria-label="Cerrar error"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── ITEMS TABLE ── */}
      <div style={styles.tableWrapper} role="region" aria-label="Artículos en carrito" tabIndex={0}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th} scope="col">Cant.</th>
              <th style={styles.th} scope="col">Producto</th>
              <th style={styles.th} scope="col">P. Unit.</th>
              <th style={styles.th} scope="col">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} style={styles.emptyRow}>
                  Carrito vacío — Escanee o busque un producto (F2)
                </td>
              </tr>
            ) : (
              items.map((item, idx) => (
                <tr
                  key={item.productId}
                  style={idx === selectedIdx ? styles.rowSelected : styles.row}
                  onClick={() => setSelectedIdx(idx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedIdx(idx);
                    }
                  }}
                  tabIndex={0}
                  role="row"
                  aria-selected={idx === selectedIdx}
                  aria-label={`${item.quantity} x ${item.name} - $${item.subtotal.toFixed(2)}`}
                >
                  <td style={styles.tdQty} aria-label="Cantidad">{item.quantity}</td>
                  <td style={styles.tdName} aria-label="Producto">{item.name}</td>
                  <td style={styles.tdPrice} aria-label="Precio unitario">${item.unitPrice.toFixed(2)}</td>
                  <td style={styles.tdSubtotal} aria-label="Subtotal">${item.subtotal.toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── TOTAL BAR ── */}
      <footer style={styles.totalBar} role="contentinfo" aria-label={`Total: ${totalRef.current.toFixed(2)} pesos`}>
        <div style={styles.cashActions}>
          <button
            type="button"
            style={styles.btnRetiro}
            onClick={() => {
              setCashType('WITHDRAWAL');
              setCashAmount('');
              setCashReason('');
              setCashError(null);
              setCashStep('FORM');
              setShowCashModal(true);
            }}
            aria-label="Retiro de efectivo"
            title="Retiro de efectivo (F9)"
          >
            ⬇ RETIRO <kbd style={styles.kbdInline}>F9</kbd>
          </button>
          <button
            type="button"
            style={styles.btnDeposito}
            onClick={() => {
              setCashType('DEPOSIT');
              setCashAmount('');
              setCashReason('');
              setCashError(null);
              setCashStep('FORM');
              setShowCashModal(true);
            }}
            aria-label="Depósito de efectivo"
            title="Depósito de efectivo (F10)"
          >
            ⬆ DEPÓSITO <kbd style={styles.kbdInline}>F10</kbd>
          </button>
        </div>
        <span style={styles.totalLabel}>TOTAL</span>
        <span style={styles.totalAmount}>${totalRef.current.toFixed(2)}</span>
      </footer>

      {/* ── MOBILE KEYPAD MODAL ── */}
      {isMobile && showKeypad && (
        <div style={styles.modalOverlay} onClick={handleKeypadEscape} role="dialog" aria-modal="true" aria-label="Teclado numérico">
          <div style={styles.mobileKeypadModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.mobileKeypadHeader}>
              <span>Entrada manual</span>
              <button type="button" onClick={handleKeypadEscape} style={styles.modalClose} aria-label="Cerrar">✕</button>
            </div>
            <NumericKeypad
              value={keypadValue}
              onChange={setKeypadValue}
              onEnter={handleKeypadEnter}
              onEscape={handleKeypadEscape}
              onBackspace={handleKeypadBackspace}
              placeholder="Código de barras..."
              autoFocus={true}
            />
          </div>
        </div>
      )}

      {/* ── PAYMENT MODAL ── */}
      {showPayModal && (
        <div style={styles.modalOverlay} onClick={() => !paymentState.loading && setShowPayModal(false)} role="dialog" aria-modal="true" aria-label="Método de pago">
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>SELECCIONAR PAGO</h2>
              <button type="button" onClick={() => setShowPayModal(false)} style={styles.modalClose} aria-label="Cancelar" disabled={paymentState.loading}>✕</button>
            </div>
            <div style={styles.modalTotal}>${totalRef.current.toFixed(2)}</div>
            <div style={styles.modalButtons}>
              <button
                type="button"
                style={{ ...styles.btnCash, opacity: paymentState.loading ? 0.5 : 1 }}
                onClick={handlePayCash}
                disabled={paymentState.loading}
                aria-label={paymentState.loading ? 'Procesando efectivo...' : 'Pagar en efectivo'}
              >
                {paymentState.loading && paymentState.method === 'CASH' ? (
                  <>
                    <span style={styles.spinner} aria-hidden="true" /> Procesando...
                  </>
                ) : (
                  '💵 EFECTIVO'
                )}
              </button>
              <button
                type="button"
                style={{ ...styles.btnCard, opacity: paymentState.loading ? 0.5 : 1 }}
                onClick={handlePayCard}
                disabled={paymentState.loading}
                aria-label={paymentState.loading ? 'Procesando tarjeta...' : 'Pagar con tarjeta'}
              >
                {paymentState.loading && paymentState.method === 'CARD' ? (
                  <>
                    <span style={styles.spinner} aria-hidden="true" /> Procesando...
                  </>
                ) : (
                  '💳 TARJETA'
                )}
              </button>
            </div>
            <div style={styles.modalHint}>ESC para cancelar</div>
          </div>
        </div>
      )}

      {/* ── CLOSE REGISTER LOADING OVERLAY ── */}
      {closeRegisterLoading && (
        <div style={styles.loadingOverlay} role="status" aria-live="polite" aria-label="Cerrando turno">
          <div style={styles.loadingSpinner} aria-hidden="true" />
          <p>Cerrando turno y calculando arqueo...</p>
        </div>
      )}

      {/* ── VOID SALE LOADING OVERLAY ── */}
      {voidSaleLoading && (
        <div style={styles.loadingOverlay} role="status" aria-live="polite" aria-label="Anulando venta">
          <div style={styles.loadingSpinner} aria-hidden="true" />
          <p>Anulando venta — requiere autorización de supervisor</p>
        </div>
      )}

      {/* ── CASH MOVEMENT MODAL ── */}
      {showCashModal && (
        <div
          style={styles.modalOverlay}
          onClick={closeCashModal}
          role="dialog"
          aria-modal="true"
          aria-label={cashType === 'WITHDRAWAL' ? 'Retiro de efectivo' : 'Depósito de efectivo'}
        >
          <div style={{ ...styles.modal, borderColor: cashType === 'WITHDRAWAL' ? '#ffaa00' : '#00ff41' }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={{ ...styles.modalTitle, color: cashType === 'WITHDRAWAL' ? '#ffaa00' : '#00ff41' }}>
                {cashType === 'WITHDRAWAL' ? '⬇ RETIRO DE EFECTIVO' : '⬆ DEPÓSITO DE EFECTIVO'}
              </h2>
              <button type="button" onClick={closeCashModal} style={styles.modalClose} aria-label="Cancelar" disabled={cashLoading}>✕</button>
            </div>
            {cashStep === 'FORM' || cashType === 'DEPOSIT' ? (
              <>
                <div style={styles.cashTypeToggle}>
                  <button
                    type="button"
                    style={cashType === 'WITHDRAWAL' ? styles.cashTypeActive : styles.cashTypeBtn}
                    onClick={() => setCashType('WITHDRAWAL')}
                    disabled={cashLoading}
                  >
                    RETIRO
                  </button>
                  <button
                    type="button"
                    style={cashType === 'DEPOSIT' ? styles.cashTypeActiveDeposit : styles.cashTypeBtn}
                    onClick={() => setCashType('DEPOSIT')}
                    disabled={cashLoading}
                  >
                    DEPÓSITO
                  </button>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  autoFocus
                  placeholder="Monto"
                  value={cashAmount}
                  onChange={(e) => setCashAmount(e.target.value)}
                  style={styles.cashInput}
                  aria-label="Monto"
                />
                <input
                  type="text"
                  placeholder={cashType === 'WITHDRAWAL' ? 'Motivo (ej: pago a proveedor)' : 'Motivo (ej: cambio inicial)'}
                  value={cashReason}
                  onChange={(e) => setCashReason(e.target.value)}
                  style={styles.cashInput}
                  aria-label="Motivo"
                />
                {cashError && (
                  <div style={styles.cashError} role="alert">{cashError}</div>
                )}
                <div style={styles.modalButtons}>
                  <button
                    type="button"
                    style={cashType === 'WITHDRAWAL' ? styles.btnRetiroConfirm : styles.btnDepositoConfirm}
                    onClick={handleCashConfirm}
                    disabled={cashLoading}
                    aria-label={cashLoading ? 'Registrando...' : 'Confirmar'}
                  >
                    {cashLoading ? 'Registrando...' : cashType === 'WITHDRAWAL' ? 'CONTINUAR' : 'CONFIRMAR'}
                  </button>
                </div>
                {cashType === 'WITHDRAWAL' && (
                  <div style={styles.modalHint}>El retiro requiere autorización de supervisor</div>
                )}
              </>
            ) : (
              <SupervisorAuthPanel
                actionLabel="AUTORIZAR RETIRO"
                note={`Retiro de $${parseFloat(cashAmount.replace(',', '.')) || 0} — ${cashReason.trim() || 'sin motivo'}`}
                loading={cashLoading}
                error={cashError}
                onCancel={() => setCashStep('FORM')}
                onSubmit={handleCashAuthorize}
              />
            )}
            <div style={styles.modalHint}>ESC para cancelar</div>
          </div>
        </div>
      )}

      {/* ── VOID SALE MODAL ── */}
      {showVoidModal && (
        <div
          style={styles.modalOverlay}
          onClick={closeVoidModal}
          role="dialog"
          aria-modal="true"
          aria-label="Anulación de venta"
        >
          <div style={{ ...styles.modal, borderColor: '#ff4444' }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={{ ...styles.modalTitle, color: '#ff4444' }}>ANULAR VENTA</h2>
              <button type="button" onClick={closeVoidModal} style={styles.modalClose} aria-label="Cancelar" disabled={voidSaleLoading}>✕</button>
            </div>
            {voidStep === 'FORM' ? (
              <>
                <p style={styles.cashError}>Se anulará la última venta registrada del turno. Esta acción es irreversible y queda registrada en auditoría.</p>
                <input
                  type="text"
                  autoFocus
                  placeholder="Motivo de la anulación"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  style={styles.cashInput}
                  aria-label="Motivo de anulación"
                />
                {voidError && (
                  <div style={styles.cashError} role="alert">{voidError}</div>
                )}
                <div style={styles.modalButtons}>
                  <button
                    type="button"
                    style={styles.btnVoidConfirm}
                    onClick={handleVoidConfirm}
                    disabled={voidSaleLoading}
                    aria-label="Continuar"
                  >
                    CONTINUAR
                  </button>
                </div>
              </>
            ) : (
              <SupervisorAuthPanel
                actionLabel="AUTORIZAR ANULACIÓN"
                note={`Motivo: ${voidReason.trim() || 'Sin motivo especificado'}`}
                loading={voidSaleLoading}
                error={voidError}
                onCancel={() => setVoidStep('FORM')}
                onSubmit={(req) => void handleVoidAuthorize(req)}
              />
            )}
            <div style={styles.modalHint}>ESC para cancelar</div>
          </div>
        </div>
      )}

      {/* ── CLOSE REGISTER MODAL (arqueo) ── */}
      {showCloseModal && (
        <div
          style={styles.modalOverlay}
          onClick={closeCloseModal}
          role="dialog"
          aria-modal="true"
          aria-label="Cierre de turno"
        >
          <div style={{ ...styles.modal, borderColor: '#4444ff' }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={{ ...styles.modalTitle, color: '#4444ff' }}>CIERRE DE TURNO</h2>
              <button type="button" onClick={closeCloseModal} style={styles.modalClose} aria-label="Cancelar" disabled={closeRegisterLoading}>✕</button>
            </div>
            <p style={styles.cashError}>Ingrese el efectivo contado en el cajón para realizar el arqueo.</p>
            <NumericKeypad
              value={closeCounted}
              onChange={(v) => { setCloseCounted(v); setCloseError(null); }}
              onEnter={() => void handleCloseRegisterConfirm()}
              onEscape={closeCloseModal}
              onBackspace={() => setCloseCounted((v) => v.slice(0, -1))}
              placeholder="Efectivo contado ($)"
              disabled={closeRegisterLoading}
              autoFocus={true}
            />
            {closeError && (
              <div style={styles.cashError} role="alert">{closeError}</div>
            )}
            <div style={styles.modalButtons}>
              <button
                type="button"
                style={styles.btnCloseConfirm}
                onClick={handleCloseRegisterConfirm}
                disabled={closeRegisterLoading || closeCounted.length === 0}
                aria-label={closeRegisterLoading ? 'Cerrando turno...' : 'Confirmar cierre'}
              >
                {closeRegisterLoading ? 'CERRANDO...' : 'CONFIRMAR CIERRE'}
              </button>
            </div>
            <div style={styles.modalHint}>ESC para cancelar</div>
          </div>
        </div>
      )}
    </div>
  );
}

function PeripheralIndicator({ label, status }: { label: string; status: string }) {
  const colors: Record<string, string> = {
    READY: '#00ff41',
    OUT_OF_PAPER: '#ffaa00',
    OFFLINE: '#ff4444',
    COVER_OPEN: '#ff4444',
    ERROR: '#ff4444',
    UNKNOWN: '#555',
    IDLE: '#555',
    PROCESSING: '#4444ff',
    APPROVED: '#00ff41',
    REJECTED: '#ff4444',
    TIMEOUT: '#ffaa00',
    DISCONNECTED: '#ff4444',
    CONNECTED: '#00ff41',
  };
  const color = colors[status] ?? '#555';
  return (
    <span style={styles.peripheralItem} title={`${label} ${status}`}>
      <span style={{ ...styles.peripheralDot, background: color }} />
      <span style={{ color, fontSize: '10px', fontWeight: 'bold' }}>{label}</span>
    </span>
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
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    flexWrap: 'wrap',
    gap: '8px',
  },
  topBarLeft: { display: 'flex', alignItems: 'center', gap: '12px' },
  shiftBadge: { color: '#00ff41', fontWeight: 'bold', fontSize: '14px' },
  mobileKeypadToggle: {
    display: 'none',
    padding: '8px 12px',
    background: '#1a3a1a',
    border: '1px solid #00ff41',
    color: '#00ff41',
    fontSize: '18px',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  shortcuts: {
    color: '#555',
    fontSize: '11px',
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  peripheralStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '4px 8px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: '6px',
  },
  peripheralItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 6px',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: '4px',
  },
  peripheralDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  searchWrapper: { padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: '8px' },
  searchInput: {
    padding: '12px 16px',
    background: '#111',
    border: '2px solid #333',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: '16px',
    borderRadius: '8px',
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  errorBanner: {
    margin: '0 16px 8px',
    padding: '10px 14px',
    background: '#3a0000',
    border: '1px solid #ff4444',
    color: '#ff8888',
    borderRadius: '6px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '13px',
  },
  errorClose: {
    padding: '2px 8px',
    background: 'transparent',
    border: '1px solid #ff4444',
    color: '#ff8888',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  tableWrapper: { flex: 1, overflow: 'auto', padding: '0 16px 8px' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: '600px' },
  th: {
    padding: '10px 16px',
    textAlign: 'left',
    background: '#1a1a1a',
    color: '#00ff41',
    borderBottom: '1px solid #2a2a2a',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  row: { borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: 'background 0.1s' },
  rowSelected: { borderBottom: '1px solid #1a1a1a', background: '#1a2a1a' },
  emptyRow: { textAlign: 'center', padding: '48px', color: '#444', fontSize: '14px' },
  tdQty: { padding: '12px 16px', fontSize: '16px', fontWeight: 'bold', color: '#00ff41', textAlign: 'center', width: '60px' },
  tdName: { padding: '12px 16px', fontSize: '15px' },
  tdPrice: { padding: '12px 16px', fontSize: '15px', textAlign: 'right', width: '100px', fontVariantNumeric: 'tabular-nums' },
  tdSubtotal: { padding: '12px 16px', fontSize: '15px', fontWeight: 'bold', textAlign: 'right', width: '120px', color: '#00ff41', fontVariantNumeric: 'tabular-nums' },
  totalBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    background: '#1a1a1a',
    borderTop: '2px solid #00ff41',
    flexShrink: 0,
    gap: '16px',
    flexWrap: 'wrap',
  },
  cashActions: { display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 0 },
  btnRetiro: {
    padding: '10px 16px',
    fontSize: '13px',
    fontWeight: 'bold',
    background: '#3a2a00',
    color: '#ffaa00',
    border: '1px solid #ffaa00',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.1s',
  },
  btnDeposito: {
    padding: '10px 16px',
    fontSize: '13px',
    fontWeight: 'bold',
    background: '#0a2a1a',
    color: '#00ff41',
    border: '1px solid #00ff41',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.1s',
  },
  kbdInline: {
    marginLeft: '6px',
    padding: '2px 6px',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid currentColor',
    borderRadius: '4px',
    fontSize: '10px',
    opacity: 0.7,
  },
  cashTypeToggle: { display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '16px' },
  cashTypeBtn: {
    padding: '8px 16px',
    fontSize: '12px',
    fontWeight: 'bold',
    background: '#1a1a1a',
    color: '#888',
    border: '1px solid #333',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cashTypeActive: {
    padding: '8px 16px',
    fontSize: '12px',
    fontWeight: 'bold',
    background: '#3a2a00',
    color: '#ffaa00',
    border: '1px solid #ffaa00',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cashTypeActiveDeposit: {
    padding: '8px 16px',
    fontSize: '12px',
    fontWeight: 'bold',
    background: '#0a2a1a',
    color: '#00ff41',
    border: '1px solid #00ff41',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cashInput: {
    width: '100%',
    padding: '12px 16px',
    marginBottom: '12px',
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: '16px',
    borderRadius: '6px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  cashError: {
    marginBottom: '12px',
    padding: '8px 12px',
    background: '#3a0000',
    border: '1px solid #ff4444',
    color: '#ff8888',
    borderRadius: '6px',
    fontSize: '12px',
  },
  btnRetiroConfirm: {
    padding: '14px 32px',
    fontSize: '14px',
    fontWeight: 'bold',
    background: '#3a2a00',
    color: '#ffaa00',
    border: '1px solid #ffaa00',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnDepositoConfirm: {
    padding: '14px 32px',
    fontSize: '14px',
    fontWeight: 'bold',
    background: '#0a2a1a',
    color: '#00ff41',
    border: '1px solid #00ff41',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnVoidConfirm: {
    padding: '14px 32px',
    fontSize: '14px',
    fontWeight: 'bold',
    background: '#2a0a0a',
    color: '#ff4444',
    border: '1px solid #ff4444',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnCloseConfirm: {
    padding: '14px 32px',
    fontSize: '14px',
    fontWeight: 'bold',
    background: '#1a1a3a',
    color: '#4444ff',
    border: '1px solid #4444ff',
    borderRadius: '6px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  totalLabel: { fontSize: '14px', color: '#888', textTransform: 'uppercase', letterSpacing: '2px' },
  totalAmount: { fontSize: '56px', fontWeight: 'bold', color: '#00ff41', fontVariantNumeric: 'tabular-nums' },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.9)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '16px',
  },
  modal: {
    background: '#111',
    border: '2px solid #00ff41',
    borderRadius: '12px',
    padding: '32px',
    textAlign: 'center',
    minWidth: '380px',
    maxWidth: '90vw',
    boxShadow: '0 0 40px rgba(0,255,65,0.15)',
  },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' },
  modalTitle: { margin: 0, fontSize: '14px', color: '#00ff41', textTransform: 'uppercase', letterSpacing: '2px' },
  modalClose: {
    padding: '4px 10px',
    background: 'transparent',
    border: '1px solid #333',
    color: '#888',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  modalTotal: { fontSize: '72px', fontWeight: 'bold', color: '#00ff41', marginBottom: '24px', fontVariantNumeric: 'tabular-nums' },
  modalButtons: { display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' },
  btnCash: {
    padding: '20px 40px',
    fontSize: '18px',
    fontWeight: 'bold',
    background: '#1a3a1a',
    color: '#00ff41',
    border: '2px solid #00ff41',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.1s',
    minWidth: '180px',
    fontFamily: 'inherit',
  },
  btnCard: {
    padding: '20px 40px',
    fontSize: '18px',
    fontWeight: 'bold',
    background: '#1a1a3a',
    color: '#4444ff',
    border: '2px solid #4444ff',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.1s',
    minWidth: '180px',
    fontFamily: 'inherit',
  },
  modalHint: { marginTop: '16px', color: '#444', fontSize: '12px' },
  mobileKeypadModal: {
    background: '#111',
    border: '2px solid #00ff41',
    borderRadius: '12px 12px 0 0',
    padding: '16px',
    width: '100%',
    maxHeight: '85vh',
    overflow: 'auto',
    boxShadow: '0 -4px 20px rgba(0,0,0,0.5)',
  },
  mobileKeypadHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  loadingOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.95)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
    color: '#00ff41',
    fontFamily: 'inherit',
    gap: '16px',
  },
  loadingSpinner: {
    width: '48px',
    height: '48px',
    border: '3px solid #1a3a1a',
    borderTopColor: '#00ff41',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  spinner: {
    display: 'inline-block',
    width: '16px',
    height: '16px',
    border: '2px solid transparent',
    borderTopColor: 'currentColor',
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
    marginRight: '8px',
    verticalAlign: 'middle',
  },
};

// Inject keyframes for spinner
if (typeof document !== 'undefined') {
  const styleSheet = document.createElement('style');
  styleSheet.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 767px) {
      .mobile-keypad-toggle { display: flex !important; align-items: center; justify-content: center; }
    }
  `;
  document.head.appendChild(styleSheet);
}

// Make mobile keypad toggle visible on mobile
const mobileStyle = document.createElement('style');
mobileStyle.textContent = `
  @media (max-width: 767px) {
    button[style*="mobileKeypadToggle"] { display: flex !important; }
  }
`;
document.head.appendChild(mobileStyle);