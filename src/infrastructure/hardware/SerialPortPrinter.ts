import { SerialPort } from 'serialport';
import { IThermalPrinter, PrinterStatus } from '../../application/ports/IPeripherals';

/**
 * Comandos ESC/POS para impresoras térmicas estándar (Epson, Star, Bixolon, etc.)
 * Referencia: https://reference.epson-biz.com/modules/ref_escpos/
 */
export class SerialPortPrinter implements IThermalPrinter {
  private port: SerialPort;
  private readonly encoding = 'utf8';

  constructor(portPath: string, baudRate = 9600) {
    this.port = new SerialPort({
      path: portPath,
      baudRate,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      // RTS/CTS flow control común en impresoras seriales
      rtscts: true,
    });
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

  async isOpen(): Promise<boolean> {
    return this.port.isOpen;
  }

  async print(content: string): Promise<void> {
    await this.open();

    const commands = this.buildTicketCommands(content);

    for (const cmd of commands) {
      await this.write(cmd);
      // Pequeña pausa entre comandos para no saturar buffer
      await this.sleep(10);
    }

    // Corte de papel (comando completo)
    await this.write(Buffer.from([0x1D, 0x56, 0x41, 0x00])); // GS V A 0 (corte parcial)
  }

  async getStatus(): Promise<PrinterStatus> {
    try {
      if (!this.port.isOpen) {
        await this.open();
      }

      // ESC v - Transmit printer status (DLE EOT 1 en Epson)
      // Nota: esto requiere reading del puerto, que es async
      // Para simplificar, asumimos READY si el puerto está abierto
      return 'READY';
    } catch {
      return 'OFFLINE';
    }
  }

  async openCashDrawer(): Promise<void> {
    await this.open();
    // ESC p m t1 t2 - Genera pulso para cajón (pin 2 o 5)
    // m=0 (cajón 1), t1=50 (50*2ms=100ms on), t2=50 (100ms off)
    await this.write(Buffer.from([0x1B, 0x70, 0x00, 0x32, 0x32]));
  }

  private async write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  private buildTicketCommands(content: string): Buffer[] {
    const cmds: Buffer[] = [];

    // Inicializar impresora (ESC @)
    cmds.push(Buffer.from([0x1B, 0x40]));

    // Codificación UTF-8 (ESC t 65001 no estándar, usamos página de códigos WPC1252)
    cmds.push(Buffer.from([0x1B, 0x74, 0x10])); // ESC t 16 = WPC1252 Latin-1

    // Área de impresión: ancho 58mm = 384 dots (58mm * 203 DPI / 25.4 ≈ 464, pero estándar 384)
    cmds.push(Buffer.from([0x1D, 0x57, 0x00, 0x00, 0x80, 0x01])); // GS W nL nH

    // Resetear a modo texto normal
    cmds.push(Buffer.from([0x1B, 0x21, 0x00])); // ESC ! 0

    // Procesar líneas del contenido
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trimEnd();

      if (trimmed.startsWith('===') || trimmed.startsWith('---')) {
        // Separadores
        cmds.push(this.textLine('-'.repeat(32), { bold: false, align: 'center' }));
      } else if (trimmed.startsWith('REPORTE') || trimmed.startsWith('DETALLE')) {
        // Títulos
        cmds.push(this.textLine(trimmed, { bold: true, align: 'center', doubleHeight: true, doubleWidth: true }));
      } else if (trimmed.includes(':')) {
        // Key: Value
        const parts = trimmed.split(':');
        const key = parts[0] ?? '';
        const value = parts.slice(1).join(':').trim();
        cmds.push(this.keyValueLine(key.trim(), value));
      } else if (trimmed.includes('|')) {
        // Tabla simple
        cmds.push(this.textLine(trimmed, { bold: false, align: 'left', font: 'A' }));
      } else if (trimmed.includes('⚠') || trimmed.includes('DESCUADRE')) {
        // Alertas
        cmds.push(this.textLine(trimmed, { bold: true, align: 'center', doubleHeight: true }));
      } else if (trimmed) {
        // Texto normal
        cmds.push(this.textLine(trimmed, { bold: false, align: 'left' }));
      } else {
        // Línea vacía
        cmds.push(this.feedLine(1));
      }
    }

    // Feed final antes de cortar
    cmds.push(this.feedLine(3));

    return cmds;
  }

  private textLine(
    text: string,
    options: { bold?: boolean; align?: 'left' | 'center' | 'right'; doubleHeight?: boolean; doubleWidth?: boolean; font?: 'A' | 'B' } = {}
  ): Buffer {
    let cmd = Buffer.alloc(0);

    // Alineación
    const alignMap = { left: 0, center: 1, right: 2 };
    cmd = Buffer.concat([cmd, Buffer.from([0x1B, 0x61, alignMap[options.align ?? 'left']])]);

    // Modo de fuente (ESC ! n)
    let mode = 0;
    if (options.bold) mode |= 0x08;
    if (options.doubleHeight) mode |= 0x10;
    if (options.doubleWidth) mode |= 0x20;
    if (options.font === 'B') mode |= 0x01;
    cmd = Buffer.concat([cmd, Buffer.from([0x1B, 0x21, mode])]);

    // Texto
    const textBuffer = Buffer.from(text + '\n', this.encoding);
    cmd = Buffer.concat([cmd, textBuffer]);

    // Reset modo
    cmd = Buffer.concat([cmd, Buffer.from([0x1B, 0x21, 0x00])]);

    return cmd;
  }

  private keyValueLine(key: string, value: string): Buffer {
    // Key a la izquierda, value a la derecha en misma línea
    const maxWidth = 32;
    const keyPart = key.length > maxWidth / 2 ? key.slice(0, maxWidth / 2 - 3) + '...' : key;
    const spaces = ' '.repeat(Math.max(1, maxWidth - keyPart.length - value.length));
    return this.textLine(`${keyPart}${spaces}${value}`, { bold: false, align: 'left' });
  }

  private feedLine(lines: number): Buffer {
    // ESC d n - Feed n lines
    return Buffer.from([0x1B, 0x64, lines]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Factory para crear impresora según configuración
 */
export type PrinterVendor = 'SERIAL' | 'USB' | 'NETWORK' | 'MOCK';

export interface PrinterConfig {
  vendor: PrinterVendor;
  portPath?: string;
  baudRate?: number;
  ipAddress?: string;
  port?: number;
}

export class PrinterFactory {
  static create(config: PrinterConfig): IThermalPrinter {
    switch (config.vendor) {
      case 'SERIAL':
        return new SerialPortPrinter(config.portPath ?? '/dev/ttyUSB0', config.baudRate ?? 9600);
      case 'USB':
        // USB usa misma interfaz serial (virtual COM port)
        return new SerialPortPrinter(config.portPath ?? '/dev/ttyUSB0', config.baudRate ?? 9600);
      case 'NETWORK':
        // TODO: Implementar NetworkPrinter (raw TCP 9100)
        throw new Error('Network printer no implementado aún');
      case 'MOCK':
      default:
        // Retornar mock desde container.mock
        throw new Error('Usar MockPrinter desde container.mock');
    }
  }
}