import React, { useState, useCallback, useEffect } from 'react';
import { AppContainer } from './container';
import { CheckoutView } from './presentation/views/CheckoutView';
import { ProductManagementView } from './presentation/views/ProductManagementView';
import { ReportsView } from './presentation/views/ReportsView';
import { User } from './domain/entities/User';
import { Shift } from './domain/entities/Shift';
import { Cart } from './domain/entities/Cart';
import { ShiftCloseSummary } from './application/use-cases/ShiftUseCases';

type AppState = 'LOGIN' | 'OPEN_SHIFT' | 'CHECKOUT' | 'PRODUCTS' | 'REPORTS';
interface AppProps { container: AppContainer; }

export function App({ container }: AppProps) {
  const { useCases, config: appConfig } = container;
  const [appState, setAppState]     = useState<AppState>('LOGIN');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentShift, setCurrentShift] = useState<Shift | null>(null);
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [closeSummary, setCloseSummary] = useState<ShiftCloseSummary | null>(null);
  const [toast, setToast]           = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleLogin = useCallback(async (userId: string, pin: string) => {
    try {
      setError(null);
      const user = await useCases.authenticate.execute(userId, pin);
      setCurrentUser(user);
      setAppState('OPEN_SHIFT');
    } catch (e) { setError(e instanceof Error ? e.message : 'Error de autenticación'); }
  }, [useCases.authenticate]);

  const handleOpenShift = useCallback(async (openingAmount: number) => {
    if (!currentUser) return;
    try {
      setError(null);
      const shift = await useCases.openShift.execute(currentUser.id, appConfig.registerId, openingAmount);
      setCurrentShift(shift);
      setAppState('CHECKOUT');
      await container.productCache.warmUp();
    } catch (e) { setError(e instanceof Error ? e.message : 'Error al abrir turno'); }
  }, [currentUser, useCases.openShift, appConfig.registerId, container.productCache]);

  const handleCloseRegister = useCallback(async (counted: number) => {
    if (!currentShift) return;
    const summary = await useCases.closeShift.execute(currentShift.id, counted);
    setCloseSummary(summary);
  }, [currentShift, useCases.closeShift]);

  const handleFinishShift = useCallback(() => {
    setCloseSummary(null);
    setCurrentShift(null);
    setCurrentUser(null);
    setLastSaleId(null);
    setAppState('LOGIN');
  }, []);

  const handlePay = useCallback(async (method: 'CASH' | 'CARD', cart: Cart) => {
    if (!currentShift || !currentUser) return;
    const result = await useCases.finalizeSale.execute(cart, currentShift.id, currentUser.id, method);
    if (result.success) {
      setLastSaleId(result.sale.id);
    } else {
      setToast(`Error: ${result.reason}`);
    }
  }, [currentShift, currentUser, useCases.finalizeSale]);

  const handleVoidSale = useCallback(async (input: { reason: string; supervisorId: string; supervisorPin: string }) => {
    if (!currentUser || !currentShift) return;
    if (!lastSaleId) {
      throw new Error('No hay una venta reciente para anular');
    }
    await useCases.voidSale.execute(
      { saleId: lastSaleId, cashierId: currentUser.id, reason: input.reason },
      input.supervisorId, input.supervisorPin, currentUser.id
    );
    setLastSaleId(null);
  }, [currentUser, currentShift, lastSaleId, useCases.voidSale]);

  const handleCashMovement = useCallback(async (
    type: 'WITHDRAWAL' | 'DEPOSIT',
    amount: number,
    reason: string,
    supervisor?: { supervisorId: string; pin: string }
  ) => {
    if (!currentUser || !currentShift) return;
    if (type === 'WITHDRAWAL') {
      if (!supervisor) return;
      await useCases.cashWithdrawal.execute(
        { shiftId: currentShift.id, type, amount, reason, authorizedBy: supervisor.supervisorId },
        supervisor.supervisorId, supervisor.pin, currentUser.id
      );
    } else {
      await useCases.cashDeposit.execute({ shiftId: currentShift.id, type, amount, reason });
    }
  }, [currentUser, currentShift, useCases.cashWithdrawal, useCases.cashDeposit]);

  const handleOpenProducts = useCallback(() => {
    // Solo SUPERVISOR y ADMIN pueden acceder a gestión de productos
    if (currentUser?.role === 'SUPERVISOR' || currentUser?.role === 'ADMIN') {
      setAppState('PRODUCTS');
    } else {
      setToast('Acceso denegado: se requiere rol SUPERVISOR o ADMIN');
    }
  }, [currentUser]);

  const handleOpenReports = useCallback(() => {
    // Solo SUPERVISOR y ADMIN pueden acceder a informes
    if (currentUser?.role === 'SUPERVISOR' || currentUser?.role === 'ADMIN') {
      setAppState('REPORTS');
    } else {
      setToast('Acceso denegado: se requiere rol SUPERVISOR o ADMIN');
    }
  }, [currentUser]);

  const handleBackFromProducts = useCallback(() => {
    setAppState('CHECKOUT');
  }, []);

  const handleBackFromReports = useCallback(() => {
    setAppState('CHECKOUT');
  }, []);

  if (appState === 'LOGIN') return <LoginView onLogin={handleLogin} error={error} />;
  if (appState === 'OPEN_SHIFT') return <OpenShiftView cashierName={currentUser?.name ?? ''} onOpen={handleOpenShift} error={error} />;
  if (appState === 'PRODUCTS') {
    return (
      <ProductManagementView
        createProduct={useCases.createProduct}
        updateProduct={useCases.updateProduct}
        deleteProduct={useCases.deleteProduct}
        listProducts={useCases.listProducts}
        importProducts={useCases.importProducts}
        receiveBatch={useCases.receiveBatch}
        onBack={handleBackFromProducts}
      />
    );
  }
  if (appState === 'REPORTS') {
    return (
      <ReportsView
        getXReport={useCases.getXReport}
        getZReport={useCases.getZReport}
        getShiftHistory={useCases.getShiftHistory}
        getShiftDetail={useCases.getShiftDetail}
        currentShiftId={currentShift?.id ?? ''}
        currentUserRole={currentUser?.role ?? ''}
        onBack={handleBackFromReports}
      />
    );
  }

  if (closeSummary) {
    return <CloseRegisterSummaryView summary={closeSummary} onFinish={handleFinishShift} />;
  }

  return (
    <>
      <CheckoutView
        addProductUseCase={useCases.addProduct}
        shiftId={currentShift?.id ?? ''}
        onPay={handlePay}
        onCloseRegister={handleCloseRegister}
        onVoidSale={handleVoidSale}
        onProducts={handleOpenProducts}
        onReports={handleOpenReports}
        onCashMovement={handleCashMovement}
        eventBus={container.eventBus}
        printer={container.hardware.printer}
        networkDetector={container.offline.networkDetector ?? undefined}
        outboxManager={container.offline.outboxManager ?? undefined}
        syncManager={container.offline.syncManager ?? undefined}
      />
      {toast && (
        <div
          role="alert"
          aria-live="assertive"
          onClick={() => setToast(null)}
          style={{
            position: 'fixed',
            top: '16px',
            right: '16px',
            zIndex: 500,
            maxWidth: '380px',
            padding: '14px 18px',
            background: '#3a0000',
            border: '1px solid #ff4444',
            color: '#ff8888',
            borderRadius: '6px',
            fontFamily: 'monospace',
            fontSize: '14px',
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}

function LoginView({ onLogin, error }: { onLogin: (id: string, pin: string) => void; error: string | null }) {
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  return (
    <div style={s.container}>
      <div style={s.card}>
        <h1 style={s.title}>SISTEMA POS</h1>
        {error && <div style={s.error}>{error}</div>}
        <input style={s.input} placeholder="ID / email" value={userId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUserId((e.target as HTMLInputElement).value)} />
        <input style={s.input} type="password" placeholder="PIN" value={pin}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPin((e.target as HTMLInputElement).value)}
          onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && onLogin(userId, pin)} />
        <button style={s.btn} onClick={() => onLogin(userId, pin)}>INGRESAR</button>
      </div>
    </div>
  );
}

function OpenShiftView({ cashierName, onOpen, error }: { cashierName: string; onOpen: (n: number) => void; error: string | null }) {
  const [amount, setAmount] = useState('');
  return (
    <div style={s.container}>
      <div style={s.card}>
        <h2 style={s.title}>Bienvenido, {cashierName}</h2>
        <p style={{ color: '#aaa', textAlign: 'center' }}>Monto de apertura de caja</p>
        {error && <div style={s.error}>{error}</div>}
        <input style={s.input} type="number" placeholder="Monto de apertura ($)" value={amount}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount((e.target as HTMLInputElement).value)}
          onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && onOpen(Number(amount))} />
        <button style={s.btn} onClick={() => onOpen(Number(amount))}>ABRIR TURNO</button>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#0d0d0d' },
  card: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '8px', padding: '48px', width: '360px', display: 'flex', flexDirection: 'column', gap: '16px' },
  title: { color: '#00ff41', textAlign: 'center', margin: 0, fontFamily: 'monospace', letterSpacing: '4px' },
  error: { background: '#3a0000', border: '1px solid #ff4444', color: '#ff8888', padding: '8px', borderRadius: '4px', fontSize: '13px' },
  input: { padding: '12px', background: '#111', border: '1px solid #333', color: '#fff', fontFamily: 'monospace', fontSize: '16px', borderRadius: '4px' },
  btn: { padding: '14px', background: '#00ff41', color: '#000', border: 'none', fontFamily: 'monospace', fontSize: '16px', fontWeight: 'bold', borderRadius: '4px', cursor: 'pointer' },
};

function CloseRegisterSummaryView({ summary, onFinish }: { summary: ShiftCloseSummary; onFinish: () => void }) {
  const rows: Array<[string, string]> = [
    ['Monto de apertura', `$${summary.openingAmount.toFixed(2)}`],
    ['Ventas efectivo', `+ $${summary.totalCashSales.toFixed(2)}`],
    ['Ventas tarjeta', `$${summary.totalCardSales.toFixed(2)} (fuera del cajón)`],
    ['Depósitos', `+ $${summary.totalDeposits.toFixed(2)}`],
    ['Retiros', `− $${summary.totalWithdrawals.toFixed(2)}`],
    ['Devoluciones', `− $${Math.abs(summary.totalRefunds).toFixed(2)}`],
    ['Esperado', `$${summary.expectedCash.toFixed(2)}`],
    ['Contado', `$${summary.countedCash.toFixed(2)}`],
    ['Diferencia', `$${summary.difference.toFixed(2)}`],
  ];
  const cardWidth = 460;
  return (
    <div style={s.container}>
      <div style={{ ...s.card, width: cardWidth }}>
        <h2 style={s.title}>TURNO CERRADO</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontFamily: 'monospace' }}>
              <span style={{ color: '#888' }}>{label}</span>
              <span style={{ color: label === 'Diferencia' ? (summary.flagged ? '#ff8888' : '#00ff41') : '#fff' }}>
                {value}
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: '12px',
            padding: '10px',
            borderRadius: '6px',
            textAlign: 'center',
            fontSize: '13px',
            fontFamily: 'monospace',
            fontWeight: 'bold',
            color: summary.flagged ? '#ff8888' : '#00ff41',
            background: summary.flagged ? '#3a0000' : '#0a2a1a',
            border: `1px solid ${summary.flagged ? '#ff4444' : '#00ff41'}`,
          }}
          role={summary.flagged ? 'alert' : 'status'}
        >
          {summary.flagged ? '⚠ DESCUADRE — informar a supervisión' : '✓ Sin diferencias'}
        </div>
        <button style={s.btn} onClick={onFinish}>FINALIZAR</button>
      </div>
    </div>
  );
}