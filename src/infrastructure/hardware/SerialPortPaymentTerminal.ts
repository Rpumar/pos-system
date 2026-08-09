import { SerialPort } from 'serialport';
import { IPaymentTerminal, PaymentResult, PaymentStatus } from '../../application/ports/IPeripherals';

/**
 * Protocolos de terminal de pago soportados
 */
export type PaymentTerminalProtocol =
  | 'POSNET'        // Argentina - Primera Red/Prisma/Link
  | 'INGENICO'      // Ingenico (ISO 8583 / Telium)
  | 'VERIFONE'      // Verifone (VF Protocol)
  | 'PAX'           // PAX (Neptune/STProtocol)
  | 'GENERIC';      // Protocolo genérico ASCII (actual)

export interface TerminalProtocolConfig {
  protocol: PaymentTerminalProtocol;
  portPath: string;
  baudRate?: number;
  // Parámetros específicos por protocolo
  merchantId?: string;
  terminalId?: string;
  timeoutMs?: number;
  // Callbacks para eventos asíncronos
  onStatusChange?: (status: PaymentStatus) => void;
}

/**
 * Implementación robusta con soporte multi-protocolo
 */
export class SerialPortPaymentTerminal implements IPaymentTerminal {
  private port: SerialPort;
  private readonly config: TerminalProtocolConfig;
  private readonly timeoutMs: number;
  private messageBuffer = Buffer.alloc(0);
  private responseResolver: ((result: PaymentResult) => void) | null = null;
  private responseTimeout: NodeJS.Timeout | null = null;

  constructor(config: TerminalProtocolConfig) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? 30_000;

    this.port = new SerialPort({
      path: config.portPath,
      baudRate: config.baudRate ?? 9600,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: true,
    });

    this.port.on('data', (data: Buffer) => this.onDataReceived(data));
    this.port.on('error', (err) => this.onError(err));
    this.port.on('close', () => this.onClose());
  }

  async open(): Promise<void> {
    if (!this.port.isOpen) {
      await new Promise<void>((resolve, reject) => {
        this.port.open((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  async close(): Promise<void> {
    if (this.port.isOpen) {
      await new Promise<void>((resolve, reject) => {
        this.port.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  async charge(amount: number): Promise<PaymentResult> {
    await this.open();
    this.config.onStatusChange?.('PROCESSING');

    const command = this.buildChargeCommand(amount);

    return new Promise((resolve) => {
      this.responseResolver = resolve;
      this.responseTimeout = setTimeout(() => {
        this.responseResolver = null;
        this.config.onStatusChange?.('TIMEOUT');
        resolve({ status: 'TIMEOUT', message: `Terminal no respondió en ${this.timeoutMs / 1000}s` });
      }, this.timeoutMs);

      this.port.write(command, (err: Error | null | undefined) => {
        if (err) {
          this.clearResponse();
          this.config.onStatusChange?.('DISCONNECTED');
          resolve({ status: 'DISCONNECTED', message: err.message });
        }
      });
    });
  }

  async reverseCharge(authCode: string, amount: number): Promise<PaymentResult> {
    await this.open();
    this.config.onStatusChange?.('PROCESSING');

    const command = this.buildReverseCommand(authCode, amount);

    return new Promise((resolve) => {
      this.responseResolver = resolve;
      this.responseTimeout = setTimeout(() => {
        this.responseResolver = null;
        this.config.onStatusChange?.('TIMEOUT');
        resolve({ status: 'TIMEOUT', message: 'Timeout en reversa' });
      }, this.timeoutMs);

      this.port.write(command, (err: Error | null | undefined) => {
        if (err) {
          this.clearResponse();
          this.config.onStatusChange?.('DISCONNECTED');
          resolve({ status: 'DISCONNECTED', message: err.message });
        }
      });
    });
  }

  async cancelCurrentTransaction(): Promise<void> {
    await this.open();
    const command = this.buildCancelCommand();
    await new Promise<void>((resolve, reject) => {
      this.port.write(command, (err) => (err ? reject(err) : resolve()));
    });
  }

  async isOnline(): Promise<boolean> {
    return this.port.isOpen;
  }

  // ── Protocol Builders ────────────────────────────────────────────────

  private buildChargeCommand(amount: number): Buffer {
    switch (this.config.protocol) {
      case 'POSNET':
        return this.buildPosnetCharge(amount);
      case 'INGENICO':
        return this.buildIngenicoCharge(amount);
      case 'VERIFONE':
        return this.buildVerifoneCharge(amount);
      case 'PAX':
        return this.buildPaxCharge(amount);
      case 'GENERIC':
      default:
        return Buffer.from(`CHARGE:${amount.toFixed(2)}\r\n`);
    }
  }

  private buildReverseCommand(authCode: string, amount: number): Buffer {
    switch (this.config.protocol) {
      case 'POSNET':
        return this.buildPosnetReverse(authCode, amount);
      case 'INGENICO':
        return this.buildIngenicoReverse(authCode, amount);
      case 'VERIFONE':
        return this.buildVerifoneReverse(authCode, amount);
      case 'PAX':
        return this.buildPaxReverse(authCode, amount);
      case 'GENERIC':
      default:
        return Buffer.from(`REVERSE:${authCode}:${amount.toFixed(2)}\r\n`);
    }
  }

  private buildCancelCommand(): Buffer {
    switch (this.config.protocol) {
      case 'POSNET':
        return Buffer.from([0x18]); // CAN
      case 'INGENICO':
        return Buffer.from([0x02, 0x43, 0x4E, 0x43, 0x03]); // STX C N C ETX
      case 'VERIFONE':
        return Buffer.from([0x18]); // CAN
      case 'PAX':
        return Buffer.from([0x18]); // CAN
      default:
        return Buffer.from([0x18]);
    }
  }

  // ── POSNET (Argentina) ─────────────────────────────────────────────
  // Protocolo ISO 8583 simplificado sobre RS-232
  private buildPosnetCharge(amount: number): Buffer {
    const amountStr = Math.round(amount * 100).toString().padStart(12, '0'); // centavos
    const msg = `0200${amountStr}000000000000${this.config.merchantId?.padStart(15, '0') ?? '000000000000000'}${this.config.terminalId?.padStart(8, '0') ?? '00000000'}`;
    const lrc = this.calculateLRC(Buffer.from(msg));
    return Buffer.concat([Buffer.from([0x02]), Buffer.from(msg), Buffer.from([0x03]), Buffer.from([lrc])]);
  }

  private buildPosnetReverse(authCode: string, amount: number): Buffer {
    const amountStr = Math.round(amount * 100).toString().padStart(12, '0');
    const msg = `0400${amountStr}${authCode.padStart(6, '0')}${this.config.merchantId?.padStart(15, '0') ?? '000000000000000'}${this.config.terminalId?.padStart(8, '0') ?? '00000000'}`;
    const lrc = this.calculateLRC(Buffer.from(msg));
    return Buffer.concat([Buffer.from([0x02]), Buffer.from(msg), Buffer.from([0x03]), Buffer.from([lrc])]);
  }

  // ── INGENICO (Telium/Tetra) ────────────────────────────────────────
  private buildIngenicoCharge(amount: number): Buffer {
    // Formato: STX + Len(2) + CMD + Data + ETX + LRC
    const amountStr = Math.round(amount * 100).toString().padStart(10, '0');
    const data = `00${amountStr}000${this.config.merchantId ?? ''}${this.config.terminalId ?? ''}`;
    const payload = Buffer.from(data);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 3); // CMD + payload
    const cmd = Buffer.from([0x30, 0x30]); // '00' = venta
    const msg = Buffer.concat([len, cmd, payload]);
    const lrc = this.calculateLRC(msg);
    return Buffer.concat([Buffer.from([0x02]), msg, Buffer.from([0x03]), Buffer.from([lrc])]);
  }

  private buildIngenicoReverse(authCode: string, amount: number): Buffer {
    const amountStr = Math.round(amount * 100).toString().padStart(10, '0');
    const data = `01${amountStr}${authCode.padStart(6, '0')}${this.config.merchantId ?? ''}${this.config.terminalId ?? ''}`;
    const payload = Buffer.from(data);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 3);
    const cmd = Buffer.from([0x30, 0x31]); // '01' = reversa
    const msg = Buffer.concat([len, cmd, payload]);
    const lrc = this.calculateLRC(msg);
    return Buffer.concat([Buffer.from([0x02]), msg, Buffer.from([0x03]), Buffer.from([lrc])]);
  }

  // ── VERIFONE (VF Protocol) ─────────────────────────────────────────
  private buildVerifoneCharge(amount: number): Buffer {
    // Comando 'SALE' con monto en centavos
    const amountCents = Math.round(amount * 100);
    return Buffer.from(`SALE ${amountCents}\r\n`);
  }

  private buildVerifoneReverse(authCode: string, amount: number): Buffer {
    const amountCents = Math.round(amount * 100);
    return Buffer.from(`VOID ${authCode} ${amountCents}\r\n`);
  }

  // ── PAX (STProtocol) ───────────────────────────────────────────────
  private buildPaxCharge(amount: number): Buffer {
    const amountCents = Math.round(amount * 100).toString().padStart(12, '0');
    return Buffer.from(`PAY${amountCents}\r\n`);
  }

  private buildPaxReverse(authCode: string, amount: number): Buffer {
    const amountCents = Math.round(amount * 100).toString().padStart(12, '0');
    return Buffer.from(`REFUND${authCode.padStart(6, '0')}${amountCents}\r\n`);
  }

  // ── Response Parsing ────────────────────────────────────────────────

  private onDataReceived(data: Buffer): void {
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);
    this.tryParseResponse();
  }

  private tryParseResponse(): void {
    // Buscar mensaje completo según protocolo
    let response: PaymentResult | null = null;

    switch (this.config.protocol) {
      case 'POSNET':
        response = this.parsePosnetResponse();
        break;
      case 'INGENICO':
        response = this.parseIngenicoResponse();
        break;
      case 'VERIFONE':
        response = this.parseVerifoneResponse();
        break;
      case 'PAX':
        response = this.parsePaxResponse();
        break;
      default:
        response = this.parseGenericResponse();
    }

    if (response && this.responseResolver) {
      this.clearResponse();
      this.config.onStatusChange?.(response.status);
      this.responseResolver(response);
      this.responseResolver = null;
    }
  }

  private parsePosnetResponse(): PaymentResult | null {
    // Busca STX ... ETX LRC
    const stxIndex = this.messageBuffer.indexOf(0x02);
    if (stxIndex === -1) return null;
    const etxIndex = this.messageBuffer.indexOf(0x03, stxIndex + 1);
    if (etxIndex === -1) return null;
    if (this.messageBuffer.length < etxIndex + 2) return null; // falta LRC

    const msg = this.messageBuffer.slice(stxIndex + 1, etxIndex);
    const lrc = this.messageBuffer[etxIndex + 1];
    const calcLrc = this.calculateLRC(Buffer.concat([Buffer.from([0x02]), msg, Buffer.from([0x03])]));

    if (lrc !== calcLrc) {
      this.messageBuffer = this.messageBuffer.slice(etxIndex + 2);
      return { status: 'REJECTED', message: 'LRC inválido' };
    }

    const raw = msg.toString();
    // Respuesta POSNET: MTI + código respuesta (pos 4-5) + código autorización
    const responseCode = raw.slice(4, 6);
    const authCode = raw.slice(6, 12).trim();

    this.messageBuffer = this.messageBuffer.slice(etxIndex + 2);

    if (responseCode === '00') {
      return { status: 'APPROVED', authCode, message: 'Aprobado' };
    }
    return { status: 'REJECTED', authCode, message: `Rechazado: ${responseCode}` };
  }

  private parseIngenicoResponse(): PaymentResult | null {
    if (this.messageBuffer.length < 6) return null; // STX + Len(2) + CMD(2) + ETX + LRC mínimo
    const stxIndex = this.messageBuffer.indexOf(0x02);
    if (stxIndex === -1) return null;

    const len = this.messageBuffer.readUInt16BE(stxIndex + 1);
    if (this.messageBuffer.length < stxIndex + 1 + 2 + len + 1 + 1) return null; // incompleto

    const msg = this.messageBuffer.slice(stxIndex + 3, stxIndex + 3 + len - 3); // sin len, cmd, ETX
    const lrc = this.messageBuffer[stxIndex + 3 + len];
    const calcLrc = this.calculateLRC(this.messageBuffer.slice(stxIndex, stxIndex + 3 + len));

    if (lrc !== calcLrc) {
      this.messageBuffer = this.messageBuffer.slice(stxIndex + 3 + len + 1);
      return { status: 'REJECTED', message: 'LRC inválido' };
    }

    // CMD = 2 bytes (ej: '00' venta, '01' reversa)
    // Primer byte de respuesta: '0'=OK, '1'=Error
    const responseCode = msg[2] !== undefined ? String.fromCharCode(msg[2]) : '1';
    const authCode = msg.length >= 9 ? msg.slice(3, 9).toString().trim() : '';

    this.messageBuffer = this.messageBuffer.slice(stxIndex + 3 + len + 1);

    if (responseCode === '0') {
      return { status: 'APPROVED', authCode, message: 'Aprobado' };
    }
    return { status: 'REJECTED', authCode, message: `Error: ${responseCode}` };
  }

  private parseVerifoneResponse(): PaymentResult | null {
    const str = this.messageBuffer.toString();
    const lines = str.split('\r\n');
    if (lines.length < 2) return null;

    const responseLine = lines[0] ?? '';
    const authCode = (lines[1] ?? '').trim();

    this.messageBuffer = Buffer.alloc(0);

    if (responseLine.startsWith('APPROVED') || responseLine.startsWith('OK')) {
      return { status: 'APPROVED', authCode, message: 'Aprobado' };
    }
    return { status: 'REJECTED', authCode, message: responseLine };
  }

  private parsePaxResponse(): PaymentResult | null {
    const str = this.messageBuffer.toString();
    if (!str.includes('\r\n')) return null;

    const lines = str.split('\r\n');
    const responseLine = lines[0] ?? '';
    const authCode = (lines[1] ?? '').trim();

    this.messageBuffer = Buffer.alloc(0);

    if (responseLine.startsWith('OK') || responseLine.startsWith('APPROVED')) {
      return { status: 'APPROVED', authCode, message: 'Aprobado' };
    }
    return { status: 'REJECTED', authCode, message: responseLine };
  }

  private parseGenericResponse(): PaymentResult | null {
    const raw = this.messageBuffer.toString().trim();
    if (!raw.endsWith('\n') && !raw.endsWith('\r')) return null; // espera fin de línea

    this.messageBuffer = Buffer.alloc(0);

    if (raw.startsWith('OK:')) {
      return { status: 'APPROVED', authCode: raw.split(':')[1], message: 'Aprobado' };
    }
    return { status: 'REJECTED', message: raw };
  }

  // ── Utilities ──────────────────────────────────────────────────────

  private calculateLRC(data: Buffer): number {
    let lrc = 0;
    for (const byte of data) {
      lrc ^= byte;
    }
    return lrc;
  }

  private clearResponse(): void {
    if (this.responseTimeout) {
      clearTimeout(this.responseTimeout);
      this.responseTimeout = null;
    }
    this.responseResolver = null;
  }

  private onError(err: Error): void {
    this.config.onStatusChange?.('DISCONNECTED');
    if (this.responseResolver) {
      this.clearResponse();
      this.responseResolver({ status: 'DISCONNECTED', message: err.message });
    }
  }

  private onClose(): void {
    this.config.onStatusChange?.('DISCONNECTED');
    if (this.responseResolver) {
      this.clearResponse();
      this.responseResolver({ status: 'DISCONNECTED', message: 'Puerto cerrado' });
    }
  }
}