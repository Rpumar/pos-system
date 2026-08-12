import { SerialPort } from 'serialport';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ── Codepage WPC1252 (ESC t 16) ──────────────────────────────────────────────
// cp1252 difiere de latin1 en 0x80-0x9F (p.ej. el euro U+20AC → 0x80).

const CP1252_EXTRA: Record<string, number> = {
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
  '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
  '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
  '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
  '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
};

function encodeCp1252(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code < 0x80) out.push(code);
    else if (CP1252_EXTRA[ch] !== undefined) out.push(CP1252_EXTRA[ch]);
    else if (code !== undefined && code <= 0xFF) out.push(code); // latin1
    else out.push(0x3F); // '?' para caracteres fuera de cp1252
  }
  return Buffer.from(out);
}

export function encodeCp1252ForTest(text: string): Buffer {
  return encodeCp1252(text);
}

export const ESC_POS_DEFAULT_WIDTH = '80';
export const ESC_POS_PAPER_WIDTHS = ['58', '80'] as const;
export type EscPosPaperWidth = (typeof ESC_POS_PAPER_WIDTHS)[number];

interface EscPosOptions {
  paperWidth: EscPosPaperWidth;
}

function charsPerLine(paperWidth: EscPosPaperWidth): number {
  return paperWidth === '58' ? 32 : 48;
}

function dotsWidth(paperWidth: EscPosPaperWidth): number {
  return paperWidth === '58' ? 384 : 576;
}

function textLineBytes(text: string, options: {
  bold?: boolean; align?: 'left' | 'center' | 'right';
  doubleHeight?: boolean; doubleWidth?: boolean; font?: 'A' | 'B';
} = {}): Buffer {
  const cmds: number[] = [];
  const alignMap = { left: 0, center: 1, right: 2 };
  cmds.push(0x1B, 0x61, alignMap[options.align ?? 'left']); // ESC a n
  let mode = 0;
  if (options.bold) mode |= 0x08;
  if (options.doubleHeight) mode |= 0x10;
  if (options.doubleWidth) mode |= 0x20;
  if (options.font === 'B') mode |= 0x01;
  cmds.push(0x1B, 0x21, mode); // ESC ! mode
  const line = Buffer.concat([encodeCp1252(text), Buffer.from([0x0A])]);
  const reset = Buffer.from([0x1B, 0x21, 0x00]);
  return Buffer.concat([Buffer.from(cmds), line, reset]);
}

function keyValueLineBytes(key: string, value: string, width: number): Buffer {
  const maxWidth = width;
  const keyPart = key.length > maxWidth / 2 ? key.slice(0, maxWidth / 2 - 3) + '...' : key;
  const spaces = ' '.repeat(Math.max(1, maxWidth - keyPart.length - value.length));
  return textLineBytes(`${keyPart}${spaces}${value}`, { bold: false, align: 'left' });
}

function feedLinesBytes(lines: number): Buffer {
  return Buffer.from([0x1B, 0x64, lines]); // ESC d n
}

/**
 * Construye el flujo ESC/POS para un ticket de texto plano.
 * Pura (sin E/S): testeable sin hardware.
 */
export function buildTicketCommands(content: string, options: EscPosOptions = { paperWidth: ESC_POS_DEFAULT_WIDTH }): Buffer[] {
  const width = charsPerLine(options.paperWidth);
  const cmds: Buffer[] = [];

  cmds.push(Buffer.from([0x1B, 0x40])); // ESC @ init
  cmds.push(Buffer.from([0x1B, 0x74, 0x10])); // ESC t 16 = WPC1252
  const dw = dotsWidth(options.paperWidth);
  cmds.push(Buffer.from([0x1D, 0x57, 0x00, 0x00, dw & 0xFF, (dw >> 8) & 0xFF])); // GS W nL nH
  cmds.push(Buffer.from([0x1B, 0x21, 0x00])); // ESC ! reset

  for (const line of content.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('===') || trimmed.startsWith('---')) {
      cmds.push(textLineBytes('-'.repeat(width), { bold: false, align: 'center' }));
    } else if (trimmed.startsWith('REPORTE') || trimmed.startsWith('DETALLE')) {
      cmds.push(textLineBytes(trimmed, { bold: true, align: 'center', doubleHeight: true, doubleWidth: true }));
    } else if (trimmed.includes(':')) {
      const parts = trimmed.split(':');
      const key = parts[0] ?? '';
      const value = parts.slice(1).join(':').trim();
      cmds.push(keyValueLineBytes(key.trim(), value, width));
    } else if (trimmed.includes('|')) {
      cmds.push(textLineBytes(trimmed, { bold: false, align: 'left', font: 'A' }));
    } else if (trimmed.includes('\u26A0') || trimmed.includes('DESCUADRE')) {
      cmds.push(textLineBytes(trimmed, { bold: true, align: 'center', doubleHeight: true }));
    } else if (trimmed) {
      cmds.push(textLineBytes(trimmed, { bold: false, align: 'left' }));
    } else {
      cmds.push(feedLinesBytes(1));
    }
  }

  cmds.push(feedLinesBytes(3));
  return cmds;
}

// ── Settings persistence (userData/printer.json) ────────────────────────────

export interface PrinterSettings {
  portPath: string;
  baudRate: number;
  paperWidth: EscPosPaperWidth;
}

const DEFAULT_SETTINGS: PrinterSettings = {
  portPath: process.env['POS_PRINTER_PORT'] ?? '',
  baudRate: Number(process.env['POS_PRINTER_BAUD_RATE'] ?? 9600),
  paperWidth: (process.env['POS_PRINTER_PAPER_WIDTH'] as EscPosPaperWidth | undefined) ?? ESC_POS_DEFAULT_WIDTH,
};

export class PrinterSettingsStore {
  constructor(private readonly filePath: string) {}

  load(): PrinterSettings {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PrinterSettings>;
      return {
        portPath: parsed.portPath ?? DEFAULT_SETTINGS.portPath,
        baudRate: parsed.baudRate ?? DEFAULT_SETTINGS.baudRate,
        paperWidth: (parsed.paperWidth && ESC_POS_PAPER_WIDTHS.includes(parsed.paperWidth))
          ? parsed.paperWidth
          : DEFAULT_SETTINGS.paperWidth,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  save(settings: PrinterSettings): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf8');
  }
}

// ── Driver térmico por puerto serie ─────────────────────────────────────────

export class SerialThermalPrinter {
  private port: SerialPort | null = null;
  private readonly settings: PrinterSettings;
  private lastError: string | null = null;

  constructor(settings: PrinterSettings) {
    this.settings = settings;
  }

  getSettings(): PrinterSettings {
    return { ...this.settings };
  }

  getError(): string | null {
    return this.lastError;
  }

  private ensureOpen(): Promise<void> {
    if (this.port?.isOpen) return Promise.resolve();
    this.lastError = null;
    return new Promise((resolve, reject) => {
      // Flow control off: la mayoría de impresoras USB (virtual COM) no usan
      // RTS/CTS; forzarlo ocasiona colgadas. Se habilita solo si se configura.
      const flowControl = process.env['POS_PRINTER_FLOW_CONTROL'] === 'rtscts';
      const port = new SerialPort({
        path: this.settings.portPath,
        baudRate: this.settings.baudRate,
        autoOpen: false,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        rtscts: flowControl,
      });
      port.open((err) => {
        if (err) {
          this.lastError = err.message;
          this.port = null;
          reject(err);
          return;
        }
        this.port = port;
        port.on('close', () => {
          if (this.port === port) this.port = null;
        });
        port.on('error', () => {
          if (this.port === port) this.port = null;
        });
        resolve();
      });
    });
  }

  private write(data: Buffer): Promise<void> {
    const port = this.port;
    if (!port) return Promise.reject(new Error('Puerto no abierto'));
    return new Promise((resolve, reject) => {
      port.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  async print(content: string): Promise<void> {
    await this.ensureOpen();
    const cmds = buildTicketCommands(content, { paperWidth: this.settings.paperWidth });
    for (const cmd of cmds) {
      await this.write(cmd);
      // Pequeña pausa entre comandos para no saturar el buffer del dispositivo.
      await new Promise((r) => setTimeout(r, 10));
    }
    await this.write(Buffer.from([0x1D, 0x56, 0x41, 0x00])); // GS V A 0 corte parcial
  }

  async openCashDrawer(): Promise<void> {
    await this.ensureOpen();
    await this.write(Buffer.from([0x1B, 0x70, 0x00, 0x32, 0x32])); // ESC p m t1 t2
  }

  async checkStatus(): Promise<PrinterStatusKind> {
    try {
      if (!this.port?.isOpen) await this.ensureOpen();
      return 'READY';
    } catch {
      this.lastError = this.lastError ?? 'No se pudo conectar a la impresora';
      return 'OFFLINE';
    }
  }

  async close(): Promise<void> {
    if (this.port?.isOpen) {
      await new Promise<void>((resolve) => this.port!.close(() => resolve()));
    }
    this.port = null;
  }
}

export type PrinterStatusKind = 'READY' | 'OUT_OF_PAPER' | 'OFFLINE' | 'COVER_OPEN' | 'ERROR';

// ── Detección de puertos serie ──────────────────────────────────────────────

export interface SerialPortInfo {
  port: string;
  manufacturer?: string;
  pnpId?: string;
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  try {
    const ports = await SerialPort.list();
    return ports
      .filter((p) => p.path)
      .map((p) => ({
        port: p.path,
        manufacturer: p.manufacturer,
        pnpId: p.pnpId,
      }));
  } catch {
    return [];
  }
}