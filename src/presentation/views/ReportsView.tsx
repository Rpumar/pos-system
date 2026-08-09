import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  GetXReportUseCase,
  GetZReportUseCase,
  GetShiftHistoryUseCase,
  GetShiftDetailUseCase,
  XReportData,
  ZReportData,
  ShiftHistoryItem,
} from '../../application/use-cases/ReportUseCases';
import { Shift } from '../../domain/entities/Shift';
import { CashMovement } from '../../domain/entities/CashMovement';
import { playSound } from '../utils/audio';
import { NumericKeypad } from '../components/NumericKeypad';

interface ReportsViewProps {
  getXReport: GetXReportUseCase;
  getZReport: GetZReportUseCase;
  getShiftHistory: GetShiftHistoryUseCase;
  getShiftDetail: GetShiftDetailUseCase;
  currentShiftId: string;
  currentUserRole: string;
  onBack: () => void;
  onCloseRegister?: (countedCash: number) => Promise<void>;
}

type ViewMode = 'history' | 'xreport' | 'zreport' | 'detail';

export function ReportsView({
  getXReport,
  getZReport,
  getShiftHistory,
  getShiftDetail,
  currentShiftId,
  currentUserRole,
  onBack,
  onCloseRegister,
}: ReportsViewProps) {
  const [mode, setMode] = useState<ViewMode>('history');
  const [shifts, setShifts] = useState<ShiftHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [xReport, setXReport] = useState<XReportData | null>(null);
  const [zReport, setZReport] = useState<ZReportData | null>(null);
  const [selectedShift, setSelectedShift] = useState<ShiftHistoryItem | null>(null);
  const [countedCash, setCountedCash] = useState('');
  const [showKeypad, setShowKeypad] = useState(false);
  const [keypadValue, setKeypadValue] = useState('');

  const isSupervisor = currentUserRole === 'SUPERVISOR' || currentUserRole === 'ADMIN';

  // Load shift history on mount
  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getShiftHistory.execute(undefined, 50);
      setShifts(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando historial');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [getShiftHistory]);

  const clearMessages = useCallback(() => {
    setError(null);
    setSuccess(null);
  }, []);

  // Keypad handlers
  const handleKeypadEnter = useCallback(() => {
    setCountedCash(keypadValue);
    setShowKeypad(false);
    setKeypadValue('');
  }, [keypadValue]);

  const handleKeypadEscape = useCallback(() => {
    setShowKeypad(false);
    setKeypadValue('');
  }, []);

  const handleKeypadBackspace = useCallback(() => {
    setKeypadValue(v => v.slice(0, -1));
  }, []);

  const openKeypad = useCallback(() => {
    setKeypadValue(countedCash);
    setShowKeypad(true);
    playSound('keypress');
  }, [countedCash]);

  // View X Report
  const handleViewXReport = useCallback(async (shiftId: string) => {
    setLoading(true);
    setError(null);
    try {
      const report = await getXReport.execute(shiftId);
      setXReport(report);
      setMode('xreport');
      playSound('scan');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error generando reporte X');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [getXReport]);

  // View Shift Detail
  const handleViewDetail = useCallback(async (shiftId: string) => {
    setLoading(true);
    setError(null);
    try {
      const detail = await getShiftDetail.execute(shiftId);
      if (detail) {
        setSelectedShift(detail);
        setMode('detail');
        playSound('scan');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando detalle');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [getShiftDetail]);

  // Generate Z Report (close shift)
  const handleGenerateZReport = useCallback(async () => {
    if (!xReport) return;
    const cash = parseFloat(countedCash);
    if (isNaN(cash)) {
      setError('Ingrese el efectivo contado');
      playSound('error');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const report = await getZReport.execute(xReport.shift.id, cash);
      setZReport(report);
      setMode('zreport');
      setSuccess('Turno cerrado correctamente');
      playSound('success');
      // Refresh history
      loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cerrando turno');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [xReport, countedCash, getZReport, loadHistory]);

  // Print/Export functions
  const printReport = useCallback((report: XReportData | ZReportData, type: 'X' | 'Z') => {
    const content = generateReportText(report, type);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte-${type}-${report.shift.id}-${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    playSound('success');
  }, []);

  const exportCSV = useCallback((report: XReportData | ZReportData, type: 'X' | 'Z') => {
    const csv = generateCSV(report, type);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte-${type}-${report.shift.id}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    playSound('success');
  }, []);

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  return (
    <div style={styles.container} role="application" aria-label="Informes y cierre">
      {/* ── HEADER ── */}
      <header style={styles.header}>
        <button type="button" onClick={onBack} style={styles.backBtn} aria-label="Volver al checkout">
          ← Volver
        </button>
        <h1 style={styles.title}>INFORMES Y CIERRE</h1>
        <div style={styles.headerActions}>
          {mode === 'history' && isSupervisor && (
            <button type="button" onClick={loadHistory} style={styles.btnSecondary} disabled={loading}>
              ↻ Actualizar
            </button>
          )}
        </div>
      </header>

      {/* ── MESSAGES ── */}
      {(error || success) && (
        <div style={styles.messages}>
          {error && <div style={styles.errorMsg} onClick={clearMessages} role="alert">{error} <span style={styles.msgClose} onClick={clearMessages}>✕</span></div>}
          {success && <div style={styles.successMsg} onClick={clearMessages} role="status">{success} <span style={styles.msgClose} onClick={clearMessages}>✕</span></div>}
        </div>
      )}

      {/* ── HISTORY VIEW ── */}
      {mode === 'history' && (
        <div style={styles.content}>
          <div style={styles.toolbar}>
            <span style={styles.subtitle}>Historial de turnos</span>
            {isSupervisor && currentShiftId && (
              <button type="button" onClick={() => handleViewXReport(currentShiftId)} style={styles.btnPrimary} disabled={loading}>
                📊 Reporte X (Turno actual)
              </button>
            )}
          </div>

          <div style={styles.tableWrapper} role="region" aria-label="Historial de turnos" tabIndex={0}>
            {loading ? (
              <div style={styles.loading}>Cargando...</div>
            ) : shifts.length === 0 ? (
              <div style={styles.emptyState}>No hay turnos registrados</div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Turno</th>
                    <th style={styles.th}>Cajero</th>
                    <th style={styles.th}>Apertura</th>
                    <th style={styles.th}>Cierre</th>
                    <th style={styles.th}>Ventas</th>
                    <th style={styles.th}>Efectivo</th>
                    <th style={styles.th}>Tarjeta</th>
                    <th style={styles.th}>Total</th>
                    <th style={styles.th}>Estado</th>
                    <th style={styles.thActions}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.map(shift => (
                    <tr key={shift.id} style={styles.row}>
                      <td style={styles.td}>{shift.id.slice(0,8)}</td>
                      <td style={styles.td}>{shift.cashierName}</td>
                      <td style={styles.td}>{formatDateTime(shift.openedAt)}</td>
                      <td style={styles.td}>{shift.closedAt ? formatDateTime(shift.closedAt) : '—'}</td>
                      <td style={styles.tdQty}>{shift.saleCount}</td>
                      <td style={styles.tdPrice}>${shift.totalCashSales.toFixed(2)}</td>
                      <td style={styles.tdPrice}>${shift.totalCardSales.toFixed(2)}</td>
                      <td style={styles.tdTotal}>${shift.totalSales.toFixed(2)}</td>
                      <td style={styles.td}>
                        <span style={{ ...styles.badge, ...(shift.status === 'OPEN' ? styles.badgeOpen : styles.badgeClosed) }}>
                          {shift.status}
                        </span>
                      </td>
                      <td style={styles.tdActions}>
                        {shift.status === 'CLOSED' && (
                          <button type="button" onClick={() => handleViewDetail(shift.id)} style={styles.btnIcon} aria-label={`Ver detalle ${shift.id}`}>👁</button>
                        )}
                        {isSupervisor && shift.id === currentShiftId && shift.status === 'OPEN' && (
                          <button type="button" onClick={() => handleViewXReport(shift.id)} style={styles.btnIconPrimary} aria-label={`Reporte X ${shift.id}`}>📊</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── X REPORT VIEW ── */}
      {mode === 'xreport' && xReport && (
        <div style={styles.reportContainer}>
          <div style={styles.reportHeader}>
            <h2 style={styles.reportTitle}>REPORTE X — {xReport.shift.id}</h2>
            <div style={styles.reportHeaderActions}>
              <button type="button" onClick={() => printReport(xReport, 'X')} style={styles.btnSecondary}>🖨 Imprimir</button>
              <button type="button" onClick={() => exportCSV(xReport, 'X')} style={styles.btnSecondary}>📥 CSV</button>
              <button type="button" onClick={() => { setMode('history'); setXReport(null); }} style={styles.btnSecondary}>← Volver</button>
              {isSupervisor && xReport.shift.status === 'OPEN' && (
                <button type="button" onClick={() => setMode('zreport')} style={styles.btnPrimary}>🔒 Cerrar (Z)</button>
              )}
            </div>
          </div>

          <div style={styles.reportContent}>
            {/* Summary Cards */}
            <div style={styles.summaryGrid}>
              <ReportCard label="Apertura" value={`$${xReport.openingAmount.toFixed(2)}`} />
              <ReportCard label="Ventas Efectivo" value={`$${xReport.totalCashSales.toFixed(2)}`} color="#00ff41" />
              <ReportCard label="Retiros" value={`$${xReport.totalWithdrawals.toFixed(2)}`} color="#ffaa00" />
              <ReportCard label="Depósitos" value={`$${xReport.totalDeposits.toFixed(2)}`} color="#4444ff" />
              <ReportCard label="Ventas Tarjeta" value={`$${xReport.totalCardSales.toFixed(2)}`} color="#4444ff" />
              <ReportCard label="ESPERADO EN CAJA" value={`$${xReport.expectedCash.toFixed(2)}`} highlight />
            </div>

            {/* Sales by Hour */}
            <SectionTitle>Ventas por Hora</SectionTitle>
            <div style={styles.tableWrapper}>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>Hora</th><th style={styles.th}>Transacciones</th><th style={styles.th}>Total</th><th style={styles.th}>Efectivo</th><th style={styles.th}>Tarjeta</th></tr></thead>
                <tbody>
                  {xReport.salesByHour.length === 0 ? (
                    <tr><td colSpan={5} style={styles.emptyState}>Sin ventas en este turno</td></tr>
                  ) : (
                    xReport.salesByHour.map(h => (
                      <tr key={h.hour} style={styles.row}>
                        <td style={styles.td}>{String(h.hour).padStart(2,'0')}:00</td>
                        <td style={styles.tdQty}>{h.count}</td>
                        <td style={styles.tdPrice}>$${h.total.toFixed(2)}</td>
                        <td style={styles.tdPrice}>$${h.cashTotal.toFixed(2)}</td>
                        <td style={styles.tdPrice}>$${h.cardTotal.toFixed(2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Sales by Method */}
            <SectionTitle>Ventas por Método</SectionTitle>
            <div style={styles.tableWrapper}>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>Método</th><th style={styles.th}>Transacciones</th><th style={styles.th}>Total</th></tr></thead>
                <tbody>
                  {xReport.salesByMethod.map(m => (
                    <tr key={m.method} style={styles.row}>
                      <td style={styles.td}>{m.method === 'CASH' ? '💵 Efectivo' : '💳 Tarjeta'}</td>
                      <td style={styles.tdQty}>{m.count}</td>
                      <td style={styles.tdPrice}>$${m.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Sales by Cashier */}
            <SectionTitle>Ventas por Cajero</SectionTitle>
            <div style={styles.tableWrapper}>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>Cajero</th><th style={styles.th}>Transacciones</th><th style={styles.th}>Total</th><th style={styles.th}>Efectivo</th><th style={styles.th}>Tarjeta</th></tr></thead>
                <tbody>
                  {xReport.salesByCashier.map(c => (
                    <tr key={c.cashierId} style={styles.row}>
                      <td style={styles.td}>{c.cashierName}</td>
                      <td style={styles.tdQty}>{c.count}</td>
                      <td style={styles.tdPrice}>$${c.total.toFixed(2)}</td>
                      <td style={styles.tdPrice}>$${c.cashTotal.toFixed(2)}</td>
                      <td style={styles.tdPrice}>$${c.cardTotal.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Top Products */}
            <SectionTitle>Top Productos</SectionTitle>
            <div style={styles.tableWrapper}>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>Producto</th><th style={styles.th}>SKU</th><th style={styles.th}>Cant.</th><th style={styles.th}>Total</th></tr></thead>
                <tbody>
                  {xReport.topProducts.map(p => (
                    <tr key={p.productId} style={styles.row}>
                      <td style={styles.tdName}>{p.name}</td>
                      <td style={styles.td}>{p.sku}</td>
                      <td style={styles.tdQty}>{p.quantity}</td>
                      <td style={styles.tdPrice}>$${p.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cash Movements */}
            <SectionTitle>Movimientos de Efectivo</SectionTitle>
            <div style={styles.tableWrapper}>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>Tipo</th><th style={styles.th}>Monto</th><th style={styles.th}>Motivo</th><th style={styles.th}>Hora</th></tr></thead>
                <tbody>
                  {xReport.cashMovements.map(m => (
                    <tr key={m.id} style={styles.row}>
                      <td style={styles.td}><span style={{ ...styles.badge, ...getMovementBadge(m.type) }}>{m.type}</span></td>
                      <td style={styles.tdPrice}>${m.amount.toFixed(2)}</td>
                      <td style={styles.td}>{m.reason ?? '—'}</td>
                      <td style={styles.td}>{formatTime(m.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Z REPORT VIEW ── */}
      {mode === 'zreport' && xReport && (
        <div style={styles.reportContainer}>
          <div style={styles.reportHeader}>
            <h2 style={styles.reportTitle}>REPORTE Z — CIERRE DE TURNO</h2>
            <div style={styles.reportHeaderActions}>
              <button type="button" onClick={() => printReport(xReport, 'Z')} style={styles.btnSecondary}>🖨 Imprimir</button>
              <button type="button" onClick={() => exportCSV(xReport, 'Z')} style={styles.btnSecondary}>📥 CSV</button>
              <button type="button" onClick={() => { setMode('xreport'); setZReport(null); }} style={styles.btnSecondary}>← Volver a X</button>
            </div>
          </div>

          {zReport ? (
            // Z Report generated - show results
            <div style={styles.reportContent}>
              <div style={styles.summaryGrid}>
                <ReportCard label="Apertura" value={`$${zReport.openingAmount.toFixed(2)}`} />
                <ReportCard label="Ventas Efectivo" value={`$${zReport.totalCashSales.toFixed(2)}`} color="#00ff41" />
                <ReportCard label="Retiros" value={`$${zReport.totalWithdrawals.toFixed(2)}`} color="#ffaa00" />
                <ReportCard label="Depósitos" value={`$${zReport.totalDeposits.toFixed(2)}`} color="#4444ff" />
                <ReportCard label="Ventas Tarjeta" value={`$${zReport.totalCardSales.toFixed(2)}`} color="#4444ff" />
                <ReportCard label="ESPERADO" value={`$${zReport.expectedCash.toFixed(2)}`} />
                <ReportCard label="CONTADO" value={`$${zReport.countedCash.toFixed(2)}`} highlight />
                <ReportCard
                  label={`DIFERENCIA ${zReport.flagged ? '⚠ DESCUADRE' : '✓ OK'}`}
                  value={`$${zReport.difference.toFixed(2)}`}
                  highlight
                  color={zReport.flagged ? '#ff4444' : '#00ff41'}
                />
              </div>

              {zReport.flagged && (
                <div style={styles.alertBox}>
                  ⚠ <strong>DESCUADRE DETECTADO:</strong> La diferencia supera el margen de tolerancia ($${CASH_TOLERANCE.toFixed(2)}).
                  Informar a supervisión inmediatamente.
                </div>
              )}

              <div style={styles.tableWrapper}>
                <table style={styles.table}>
                  <thead><tr><th style={styles.th}>Hora</th><th style={styles.th}>Transacciones</th><th style={styles.th}>Total</th><th style={styles.th}>Efectivo</th><th style={styles.th}>Tarjeta</th></tr></thead>
                  <tbody>
                    {zReport.salesByHour.map(h => (
                      <tr key={h.hour} style={styles.row}>
                        <td style={styles.td}>{String(h.hour).padStart(2,'0')}:00</td>
                        <td style={styles.tdQty}>{h.count}</td>
                        <td style={styles.tdPrice}>$${h.total.toFixed(2)}</td>
                        <td style={styles.tdPrice}>$${h.cashTotal.toFixed(2)}</td>
                        <td style={styles.tdPrice}>$${h.cardTotal.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            // Z Report input form
            <div style={styles.reportContent}>
              <div style={styles.zInputCard}>
                <h3 style={styles.zInputTitle}>ARQUEO DE CAJA</h3>
                <p style={styles.zInputDesc}>Ingrese el efectivo físico contado en el cajón:</p>
                <div style={styles.zInputWrapper}>
                  <input
                    type="text"
                    value={countedCash}
                    onChange={e => setCountedCash(e.target.value)}
                    onClick={openKeypad}
                    readOnly
                    style={styles.zInput}
                    placeholder="0.00"
                    aria-label="Efectivo contado"
                  />
                  {isMobile && showKeypad && (
                    <NumericKeypad
                      value={keypadValue}
                      onChange={setKeypadValue}
                      onEnter={handleKeypadEnter}
                      onEscape={handleKeypadEscape}
                      onBackspace={handleKeypadBackspace}
                      placeholder="0.00"
                      autoFocus={true}
                    />
                  )}
                </div>
                <p style={styles.zExpected}>Esperado en caja: <strong>$${xReport.expectedCash.toFixed(2)}</strong></p>
                <button
                  type="button"
                  onClick={handleGenerateZReport}
                  style={styles.btnPrimary}
                  disabled={loading}
                >
                  {loading ? 'Cerrando turno...' : 'CONFIRMAR CIERRE (Z)'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── DETAIL VIEW ── */}
      {mode === 'detail' && selectedShift && (
        <div style={styles.reportContainer}>
          <div style={styles.reportHeader}>
            <h2 style={styles.reportTitle}>DETALLE DE TURNO — {selectedShift.id}</h2>
            <div style={styles.reportHeaderActions}>
              <button type="button" onClick={() => { setMode('history'); setSelectedShift(null); }} style={styles.btnSecondary}>← Volver</button>
            </div>
          </div>

          <div style={styles.reportContent}>
            <div style={styles.summaryGrid}>
              <ReportCard label="Cajero" value={selectedShift.cashierName} />
              <ReportCard label="Caja" value={selectedShift.registerId} />
              <ReportCard label="Apertura" value={formatDateTime(selectedShift.openedAt)} />
              <ReportCard label="Cierre" value={selectedShift.closedAt ? formatDateTime(selectedShift.closedAt) : '—'} />
              <ReportCard label="Monto Apertura" value={`$${selectedShift.openingAmount.toFixed(2)}`} />
              <ReportCard label="Esperado" value={selectedShift.expectedCash ? `$${selectedShift.expectedCash.toFixed(2)}` : '—'} />
              <ReportCard label="Contado" value={selectedShift.countedCash ? `$${selectedShift.countedCash.toFixed(2)}` : '—'} />
              <ReportCard label="Diferencia" value={selectedShift.difference !== null ? `$${selectedShift.difference.toFixed(2)}` : '—'} color={selectedShift.difference && Math.abs(selectedShift.difference) > CASH_TOLERANCE ? '#ff4444' : '#00ff41'} />
              <ReportCard label="Estado" value={selectedShift.status} />
              <ReportCard label="Total Ventas" value={`$${selectedShift.totalSales.toFixed(2)}`} highlight />
              <ReportCard label="Transacciones" value={String(selectedShift.saleCount)} />
            </div>
          </div>
        </div>
      )}

      {/* ── MOBILE KEYPAD MODAL ── */}
      {isMobile && showKeypad && (
        <div style={styles.modalOverlay} onClick={handleKeypadEscape} role="dialog" aria-modal="true" aria-label="Teclado numérico">
          <div style={styles.mobileKeypadModal} onClick={e => e.stopPropagation()}>
            <div style={styles.mobileKeypadHeader}>
              <span>Efectivo Contado</span>
              <button type="button" onClick={handleKeypadEscape} style={styles.modalClose} aria-label="Cerrar">✕</button>
            </div>
            <NumericKeypad
              value={keypadValue}
              onChange={setKeypadValue}
              onEnter={handleKeypadEnter}
              onEscape={handleKeypadEscape}
              onBackspace={handleKeypadBackspace}
              placeholder="0.00"
              autoFocus={true}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helper Components ──

function ReportCard({ label, value, color = '#888', highlight = false }: { label: string; value: string; color?: string; highlight?: boolean }) {
  return (
    <div style={{
      background: '#1a1a1a',
      border: highlight ? '2px solid #00ff41' : '1px solid #2a2a2a',
      borderRadius: '8px',
      padding: '16px',
      textAlign: 'center',
      minWidth: '140px',
    }}>
      <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: highlight ? '24px' : '18px', fontWeight: 'bold', color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 style={styles.sectionTitle}>{children}</h3>;
}

// ── Helper Functions ──

const CASH_TOLERANCE = 1.00;

function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function getMovementBadge(type: string): React.CSSProperties {
  switch (type) {
    case 'SALE_CASH': return { background: '#1a3a1a', color: '#00ff41', borderColor: '#00ff41' };
    case 'WITHDRAWAL': return { background: '#3a1a1a', color: '#ff4444', borderColor: '#ff4444' };
    case 'DEPOSIT': return { background: '#1a1a3a', color: '#4444ff', borderColor: '#4444ff' };
    case 'REFUND': return { background: '#3a3a1a', color: '#ffaa00', borderColor: '#ffaa00' };
    default: return { background: '#2a2a2a', color: '#888', borderColor: '#333' };
  }
}

function generateReportText(report: XReportData | ZReportData, type: 'X' | 'Z'): string {
  const lines = [
    '========================================',
    `      REPORTE ${type} — ${report.shift.id}`,
    '========================================',
    '',
    `Fecha: ${new Date().toLocaleString('es-AR')}`,
    `Turno: ${report.shift.id}`,
    `Cajero: ${report.shift.cashierId}`,
    `Caja: ${report.shift.registerId}`,
    `Estado: ${report.shift.status}`,
    '',
    '--- RESUMEN DE CAJA ---',
    `  Apertura:           $${report.openingAmount.toFixed(2)}`,
    `  Ventas Efectivo:    $${report.totalCashSales.toFixed(2)}`,
    `  Retiros:            $${report.totalWithdrawals.toFixed(2)}`,
    `  Depósitos:          $${report.totalDeposits.toFixed(2)}`,
    `  Ventas Tarjeta:     $${report.totalCardSales.toFixed(2)}`,
    `  ESPERADO:           $${report.expectedCash.toFixed(2)}`,
  ];

  if (type === 'Z' && 'countedCash' in report) {
    const zr = report as ZReportData;
    lines.push(
      `  CONTADO:            $${zr.countedCash.toFixed(2)}`,
      `  DIFERENCIA:         $${zr.difference.toFixed(2)} ${zr.flagged ? '⚠ DESCUADRE' : '✓ OK'}`,
      '',
      '--- VENTAS POR HORA ---',
    );
  } else {
    lines.push('', '--- VENTAS POR HORA ---');
  }

  for (const h of report.salesByHour) {
    lines.push(`  ${String(h.hour).padStart(2,'0')}:00  |  ${h.count} tx  |  $${h.total.toFixed(2)}  |  E:$${h.cashTotal.toFixed(2)}  T:$${h.cardTotal.toFixed(2)}`);
  }

  lines.push('', '--- VENTAS POR MÉTODO ---');
  for (const m of report.salesByMethod) {
    lines.push(`  ${m.method === 'CASH' ? 'Efectivo' : 'Tarjeta '}  |  ${m.count} tx  |  $${m.total.toFixed(2)}`);
  }

  lines.push('', '--- VENTAS POR CAJERO ---');
  for (const c of report.salesByCashier) {
    lines.push(`  ${c.cashierName}  |  ${c.count} tx  |  $${c.total.toFixed(2)}  |  E:$${c.cashTotal.toFixed(2)}  T:$${c.cardTotal.toFixed(2)}`);
  }

  lines.push('', '--- TOP PRODUCTOS ---');
  for (const p of report.topProducts) {
    lines.push(`  ${p.name} (${p.sku})  |  ${p.quantity} uds  |  $${p.total.toFixed(2)}`);
  }

  lines.push('', '--- MOVIMIENTOS DE EFECTIVO ---');
  for (const m of report.cashMovements) {
    lines.push(`  ${m.type}  |  $${m.amount.toFixed(2)}  |  ${m.reason ?? '-'}  |  ${formatTime(m.createdAt)}`);
  }

  lines.push('', '========================================');
  return lines.join('\n');
}

function generateCSV(report: XReportData | ZReportData, type: 'X' | 'Z'): string {
  const lines = [
    `Reporte ${type},${report.shift.id},${new Date().toISOString()}`,
    'Sección,Campo,Valor',
    'Resumen,Apertura,' + report.openingAmount.toFixed(2),
    'Resumen,Ventas Efectivo,' + report.totalCashSales.toFixed(2),
    'Resumen,Retiros,' + report.totalWithdrawals.toFixed(2),
    'Resumen,Depósitos,' + report.totalDeposits.toFixed(2),
    'Resumen,Ventas Tarjeta,' + report.totalCardSales.toFixed(2),
    'Resumen,Esperado,' + report.expectedCash.toFixed(2),
  ];

  if (type === 'Z' && 'countedCash' in report) {
    const zr = report as ZReportData;
    lines.push(
      'Resumen,Contado,' + zr.countedCash.toFixed(2),
      'Resumen,Diferencia,' + zr.difference.toFixed(2),
      'Resumen,Descuadre,' + (zr.flagged ? 'SI' : 'NO')
    );
  }

  lines.push('Ventas por Hora,Hora,Transacciones,Total,Efectivo,Tarjeta');
  for (const h of report.salesByHour) {
    lines.push(`Ventas por Hora,${h.hour},${h.count},${h.total.toFixed(2)},${h.cashTotal.toFixed(2)},${h.cardTotal.toFixed(2)}`);
  }

  lines.push('Ventas por Método,Método,Transacciones,Total');
  for (const m of report.salesByMethod) {
    lines.push(`Ventas por Método,${m.method},${m.count},${m.total.toFixed(2)}`);
  }

  lines.push('Ventas por Cajero,Cajero,Transacciones,Total,Efectivo,Tarjeta');
  for (const c of report.salesByCashier) {
    lines.push(`Ventas por Cajero,${c.cashierName},${c.count},${c.total.toFixed(2)},${c.cashTotal.toFixed(2)},${c.cardTotal.toFixed(2)}`);
  }

  lines.push('Top Productos,Producto,SKU,Cantidad,Total');
  for (const p of report.topProducts) {
    lines.push(`Top Productos,"${p.name}",${p.sku},${p.quantity},${p.total.toFixed(2)}`);
  }

  lines.push('Movimientos Efectivo,Tipo,Monto,Motivo,Hora');
  for (const m of report.cashMovements) {
    lines.push(`Movimientos Efectivo,${m.type},${m.amount.toFixed(2)},"${m.reason ?? ''}",${formatTime(m.createdAt)}`);
  }

  return lines.join('\n');
}

// ── Mobile Keypad Modal Component ──

function NumericKeypadModal({ value, onChange, onEnter, onEscape, onBackspace }: {
  value: string; onChange: (v: string) => void; onEnter: () => void; onEscape: () => void; onBackspace: () => void;
}) {
  const KEYS = [['1','2','3'],['4','5','6'],['7','8','9'],['.','0','⌫']] as const;
  return (
    <div style={styles.keypadContainer}>
      <div style={styles.keypadDisplay}>
        <input value={value} readOnly style={styles.keypadInput} />
      </div>
      <div style={styles.keypadGrid}>
        {KEYS.map((row, ri) => (
          <div key={ri} style={styles.keypadRow}>
            {row.map(key => (
              <button key={key} type="button" onClick={() => key === '⌫' ? onBackspace() : onChange(value + key)} style={styles.keypadBtn}>
                {key === '⌫' ? '⌫' : key}
              </button>
            ))}
          </div>
        ))}
        <button type="button" onClick={onEnter} style={styles.keypadEnter} disabled={value.length === 0}>CONFIRMAR</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d0d0d', color: '#fff', fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#1a1a1a', borderBottom: '1px solid #2a2a2a', flexWrap: 'wrap', gap: '12px' },
  backBtn: { padding: '8px 16px', background: '#1a1a1a', border: '1px solid #333', color: '#888', fontFamily: 'inherit', fontSize: '13px', borderRadius: '6px', cursor: 'pointer' },
  title: { color: '#00ff41', fontWeight: 'bold', fontSize: '16px', letterSpacing: '2px', margin: 0 },
  headerActions: { display: 'flex', gap: '8px' },
  messages: { padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: '8px' },
  errorMsg: { padding: '10px 14px', background: '#3a0000', border: '1px solid #ff4444', color: '#ff8888', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' },
  successMsg: { padding: '10px 14px', background: '#1a3a1a', border: '1px solid #00ff41', color: '#00ff41', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' },
  msgClose: { cursor: 'pointer', color: '#888', marginLeft: '8px' },
  content: { flex: 1, overflow: 'auto', padding: '16px' },
  toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' },
  subtitle: { color: '#00ff41', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '2px' },
  btnPrimary: { padding: '10px 20px', background: '#1a3a1a', color: '#00ff41', border: '1px solid #00ff41', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' },
  btnSecondary: { padding: '10px 20px', background: '#1a1a1a', color: '#aaa', border: '1px solid #333', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' },
  btnIcon: { padding: '6px 10px', background: '#1a1a3a', color: '#4444ff', border: '1px solid #4444ff', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
  btnIconPrimary: { padding: '6px 10px', background: '#1a3a1a', color: '#00ff41', border: '1px solid #00ff41', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
  tableWrapper: { overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: '1000px' },
  th: { padding: '10px 12px', textAlign: 'left', background: '#1a1a1a', color: '#00ff41', borderBottom: '1px solid #2a2a2a', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', position: 'sticky', top: 0, zIndex: 1 },
  row: { borderBottom: '1px solid #1a1a1a', transition: 'background 0.1s' },
  td: { padding: '10px 12px', fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
  tdQty: { padding: '10px 12px', fontSize: '13px', textAlign: 'center', color: '#00ff41', fontWeight: 'bold' },
  tdName: { padding: '10px 12px', fontSize: '13px', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tdPrice: { padding: '10px 12px', fontSize: '13px', textAlign: 'right', color: '#00ff41', fontVariantNumeric: 'tabular-nums' },
  tdTotal: { padding: '10px 12px', fontSize: '13px', textAlign: 'right', fontWeight: 'bold', color: '#00ff41', fontVariantNumeric: 'tabular-nums' },
  tdActions: { padding: '6px 12px', textAlign: 'right', whiteSpace: 'nowrap' },
  badge: { padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' },
  badgeOpen: { background: '#1a3a1a', color: '#00ff41', border: '1px solid #00ff41' },
  badgeClosed: { background: '#2a2a2a', color: '#888', border: '1px solid #333' },
  emptyState: { textAlign: 'center', padding: '48px', color: '#444', fontSize: '14px' },
  loading: { textAlign: 'center', padding: '48px', color: '#00ff41', fontSize: '14px' },
  reportContainer: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' },
  reportHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', background: '#1a1a1a', borderBottom: '1px solid #2a2a2a', flexWrap: 'wrap', gap: '12px' },
  reportTitle: { margin: 0, color: '#00ff41', fontSize: '16px', textTransform: 'uppercase', letterSpacing: '2px' },
  reportHeaderActions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  reportContent: { flex: 1, padding: '24px', overflow: 'auto' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' },
  sectionTitle: { color: '#00ff41', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '2px', margin: '24px 0 12px', borderBottom: '1px solid #2a2a2a', paddingBottom: '8px' },
  alertBox: { padding: '16px', background: '#3a0000', border: '1px solid #ff4444', borderRadius: '8px', color: '#ff8888', marginBottom: '24px' },
  zInputCard: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '12px', padding: '32px', maxWidth: '400px', margin: '0 auto', textAlign: 'center' },
  zInputTitle: { margin: '0 0 8px', color: '#00ff41', fontSize: '16px' },
  zInputDesc: { color: '#888', marginBottom: '24px' },
  zInputWrapper: { marginBottom: '16px' },
  zInput: { width: '100%', padding: '20px', fontSize: '32px', fontWeight: 'bold', textAlign: 'center', background: '#111', border: '2px solid #333', borderRadius: '8px', color: '#00ff41', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' },
  zExpected: { color: '#888', marginBottom: '24px', fontSize: '14px' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 200 },
  mobileKeypadModal: { background: '#111', border: '2px solid #00ff41', borderRadius: '12px 12px 0 0', padding: '16px', width: '100%', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 -4px 20px rgba(0,0,0,0.5)' },
  mobileKeypadHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  modalClose: { padding: '4px 10px', background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
  keypadContainer: { background: '#111', border: '2px solid #00ff41', borderRadius: '12px 12px 0 0', padding: '16px', width: '100%', boxShadow: '0 -4px 20px rgba(0,0,0,0.5)' },
  keypadDisplay: { marginBottom: '16px' },
  keypadInput: { width: '100%', padding: '20px', fontSize: '28px', fontWeight: 'bold', textAlign: 'center', background: '#0d0d0d', border: '2px solid #333', borderRadius: '8px', color: '#00ff41', fontFamily: 'inherit' },
  keypadGrid: { display: 'flex', flexDirection: 'column', gap: '10px' },
  keypadRow: { display: 'flex', gap: '10px', justifyContent: 'center' },
  keypadBtn: { width: '80px', height: '64px', background: '#1a1a1a', border: '1px solid #333', color: '#fff', fontFamily: 'inherit', fontSize: '24px', fontWeight: 'bold', borderRadius: '8px', cursor: 'pointer' },
  keypadEnter: { width: '100%', height: '56px', marginTop: '10px', background: '#1a3a1a', border: '1px solid #00ff41', color: '#00ff41', fontFamily: 'inherit', fontSize: '16px', fontWeight: 'bold', borderRadius: '8px', cursor: 'pointer' },
};