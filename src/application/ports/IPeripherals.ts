// ── Terminal de pago ──────────────────────────────────────────────────────────

export type PaymentStatus =
  | 'IDLE'
  | 'PROCESSING'
  | 'APPROVED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'DISCONNECTED';

export interface PaymentResult {
  status: PaymentStatus;
  authCode?: string;
  message: string;
}

export interface IPaymentTerminal {
  charge(amount: number): Promise<PaymentResult>;
  reverseCharge(authCode: string, amount: number): Promise<PaymentResult>;
  cancelCurrentTransaction(): Promise<void>;
  isOnline(): Promise<boolean>;
}

// ── Impresora térmica ─────────────────────────────────────────────────────────

export type PrinterStatus = 'READY' | 'OUT_OF_PAPER' | 'OFFLINE' | 'COVER_OPEN' | 'ERROR';

export interface IThermalPrinter {
  print(content: string): Promise<void>;
  getStatus(): Promise<PrinterStatus>;
  openCashDrawer(): Promise<void>;
}

export interface PrinterInfo {
  vendor: string;
  model: string;
  serialNumber?: string;
  firmwareVersion?: string;
}
