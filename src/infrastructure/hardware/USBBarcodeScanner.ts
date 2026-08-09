import { EventEmitter } from 'events';

// Import node-hid dynamically to handle different module structures
let HID: any;
try {
  HID = require('node-hid');
} catch {
  HID = null;
}

/**
 * Soporte para lectores de código de barras USB HID dedicados
 * (ej. Honeywell Xenon, Zebra DS2208, Datalogic Gryphon, Symbol LS2208)
 *
 * A diferencia del ScannerDetector basado en teclado, estos dispositivos
 * aparecen como HID raw y no pasan por el sistema de input del OS.
 */

export interface USBScannerConfig {
  vendorId: number;
  productId: number;
  // Configuración específica del dispositivo
  interface?: number;        // Interface HID (usualmente 0)
  endpoint?: number;         // Endpoint IN (usualmente 0x81)
  reportSize?: number;       // Tamaño del report (ej. 64, 8)
  // Mapeo de códigos de tecla a caracteres
  keyMap?: Record<number, string>;
  // Configuración de filtrado
  minCodeLength?: number;
  maxCodeLength?: number;
  // Callback cuando se detecta un código completo
  onScan?: (barcode: string) => void;
}

const DEFAULT_KEY_MAP: Record<number, string> = {
  0x04: 'a', 0x05: 'b', 0x06: 'c', 0x07: 'd', 0x08: 'e', 0x09: 'f',
  0x0A: 'g', 0x0B: 'h', 0x0C: 'i', 0x0D: 'j', 0x0E: 'k', 0x0F: 'l',
  0x10: 'm', 0x11: 'n', 0x12: 'o', 0x13: 'p', 0x14: 'q', 0x15: 'r',
  0x16: 's', 0x17: 't', 0x18: 'u', 0x19: 'v', 0x1A: 'w', 0x1B: 'x',
  0x1C: 'y', 0x1D: 'z', 0x1E: '1', 0x1F: '2', 0x20: '3', 0x21: '4',
  0x22: '5', 0x23: '6', 0x24: '7', 0x25: '8', 0x26: '9', 0x27: '0',
  0x28: '\n',  // Enter
  0x2A: '\x1b', // Escape
  0x2C: ' ',   // Space
  0x2D: '-', 0x2E: '=', 0x2F: '[', 0x30: ']', 0x31: '\\',
  0x33: ';', 0x34: '\'', 0x35: '`', 0x36: ',', 0x37: '.', 0x38: '/',
};

export class USBBarcodeScanner extends EventEmitter {
  private device: any;
  private readonly config: Required<USBScannerConfig>;
  private buffer = '';
  private isOpen = false;
  private readInterval: NodeJS.Timeout | null = null;

  constructor(config: USBScannerConfig) {
    super();
    if (!HID) {
      throw new Error('node-hid no está disponible. Instale con: npm install node-hid');
    }
    this.config = {
      vendorId: config.vendorId,
      productId: config.productId,
      interface: config.interface ?? 0,
      endpoint: config.endpoint ?? 0x81,
      reportSize: config.reportSize ?? 64,
      keyMap: config.keyMap ?? DEFAULT_KEY_MAP,
      minCodeLength: config.minCodeLength ?? 6,
      maxCodeLength: config.maxCodeLength ?? 20,
      onScan: config.onScan ?? (() => {}),
    };
  }

  /**
   * Lista dispositivos HID disponibles (útil para auto-detección)
   */
  static listDevices(): Array<{ vendorId: number; productId: number; path: string; manufacturer?: string; product?: string }> {
    if (!HID) return [];
    try {
      const devices = HID.devices?.() ?? [];
      return devices
        .filter((d: any) => d.interface === 0)
        .map((d: any) => ({
          vendorId: d.vendorId,
          productId: d.productId,
          path: d.path,
          manufacturer: d.manufacturer,
          product: d.product,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Intenta auto-detectar un scanner conocido
   */
  static autoDetect(): USBScannerConfig | null {
    const knownScanners: Array<{ vendorId: number; productId: number; name: string }> = [
      { vendorId: 0x0c2e, productId: 0x0b00, name: 'Honeywell Xenon 1900' },
      { vendorId: 0x0c2e, productId: 0x0b01, name: 'Honeywell Voyager 1400g' },
      { vendorId: 0x05e0, productId: 0x1200, name: 'Symbol LS2208' },
      { vendorId: 0x05e0, productId: 0x0600, name: 'Symbol LS4208' },
      { vendorId: 0x067b, productId: 0x2303, name: 'Generic USB-Serial (Prolific)' },
      { vendorId: 0x10c4, productId: 0xea60, name: 'CP210x UART Bridge' },
      { vendorId: 0x04d8, productId: 0x003f, name: 'Datalogic Gryphon' },
      { vendorId: 0x053c, productId: 0x0016, name: 'Zebra DS2208' },
    ];

    const devices = this.listDevices();
    for (const scanner of knownScanners) {
      const found = devices.find(d => d.vendorId === scanner.vendorId && d.productId === scanner.productId);
      if (found) {
        return { vendorId: scanner.vendorId, productId: scanner.productId };
      }
    }
    return null;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    if (!HID) throw new Error('node-hid no disponible');

    try {
      // HID.HID o HID directo según versión
      const HIDConstructor = HID.HID ?? HID;
      this.device = new HIDConstructor(this.config.vendorId, this.config.productId);
      this.isOpen = true;

      // Iniciar lectura continua
      this.readInterval = setInterval(() => this.readReport(), 10);

      this.emit('open');
    } catch (error) {
      this.isOpen = false;
      throw new Error(`No se pudo abrir scanner USB: ${error instanceof Error ? error.message : 'Error desconocido'}`);
    }
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;

    if (this.readInterval) {
      clearInterval(this.readInterval);
      this.readInterval = null;
    }

    if (this.device) {
      try { this.device.close(); } catch {}
      this.device = null;
    }

    this.isOpen = false;
    this.emit('close');
  }

  private readReport(): void {
    if (!this.device || !this.isOpen) return;

    try {
      const data = this.device.read(this.config.reportSize);
      if (data && data.length > 0) {
        this.processReport(data);
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private processReport(report: Buffer): void {
    // El primer byte suele ser el Report ID (0 o 1), ignorar
    const start = report[0] === 0 || report[0] === 1 ? 1 : 0;

    for (let i = start; i < report.length; i++) {
      const keyCode = report[i];
      if (keyCode === undefined || keyCode === 0) continue; // Null padding

      const char = this.config.keyMap[keyCode];
      if (!char) continue; // Tecla no mapeada (shift, ctrl, etc.)

      if (char === '\n') {
        // Enter = fin de código
        const code = this.buffer.trim();
        this.buffer = '';
        if (code.length >= this.config.minCodeLength && code.length <= this.config.maxCodeLength) {
          this.emit('scan', code);
          this.config.onScan(code);
        }
      } else if (char === '\x1b') {
        // Escape = cancelar buffer
        this.buffer = '';
      } else {
        this.buffer += char;
      }
    }
  }

  getIsOpen(): boolean {
    return this.isOpen;
  }
}

/**
 * Factory para crear scanner según configuración
 */
export type ScannerType = 'HID_KEYBOARD' | 'USB_HID' | 'SERIAL' | 'NONE';

export interface ScannerConfig {
  type: ScannerType;
  // HID Keyboard (actual ScannerDetector)
  scannerThresholdMs?: number;
  minCodeLength?: number;
  // USB HID
  vendorId?: number;
  productId?: number;
  // Serial
  portPath?: string;
  baudRate?: number;
}

export class ScannerFactory {
  static create(config: ScannerConfig): { scanner: any; type: ScannerType } {
    switch (config.type) {
      case 'USB_HID':
        if (!config.vendorId || !config.productId) {
          const auto = USBBarcodeScanner.autoDetect();
          if (!auto) throw new Error('No se detectó scanner USB HID. Especifique vendorId/productId.');
          return {
            scanner: new USBBarcodeScanner(auto),
            type: 'USB_HID',
          };
        }
        return {
          scanner: new USBBarcodeScanner({ vendorId: config.vendorId, productId: config.productId }),
          type: 'USB_HID',
        };

      case 'HID_KEYBOARD':
      default:
        // Usar ScannerDetector existente
        const { ScannerDetector } = require('../presentation/services/ScannerDetector');
        return {
          scanner: new ScannerDetector(config.scannerThresholdMs, config.minCodeLength),
          type: 'HID_KEYBOARD',
        };
    }
  }
}