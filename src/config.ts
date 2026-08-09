import { join } from 'path';

export const config = {
  db: { path: process.env['POS_DB_PATH'] ?? join(process.cwd(), 'data', 'pos.db') },
  terminal: {
    vendor: (process.env['POS_TERMINAL_VENDOR'] ?? 'MOCK') as 'SERIAL' | 'MOCK',
    protocol: (process.env['POS_TERMINAL_PROTOCOL'] ?? 'GENERIC') as 'POSNET' | 'INGENICO' | 'VERIFONE' | 'PAX' | 'GENERIC',
    portPath: process.env['POS_SERIAL_PORT'] ?? '/dev/ttyUSB0',
    baudRate: Number(process.env['POS_BAUD_RATE'] ?? 9600),
    merchantId: process.env['POS_TERMINAL_MERCHANT_ID'] ?? '',
    terminalId: process.env['POS_TERMINAL_ID'] ?? '',
    timeoutMs: Number(process.env['POS_TERMINAL_TIMEOUT_MS'] ?? 30_000),
  },
  printer: {
    vendor: (process.env['POS_PRINTER_VENDOR'] ?? 'MOCK') as 'SERIAL' | 'USB' | 'NETWORK' | 'MOCK',
    portPath: process.env['POS_PRINTER_PORT'] ?? '/dev/ttyUSB0',
    baudRate: Number(process.env['POS_PRINTER_BAUD_RATE'] ?? 9600),
  },
  scanner: {
    type: (process.env['POS_SCANNER_TYPE'] ?? 'HID_KEYBOARD') as 'HID_KEYBOARD' | 'USB_HID' | 'SERIAL' | 'NONE',
    vendorId: Number(process.env['POS_SCANNER_VENDOR_ID'] ?? '0'),
    productId: Number(process.env['POS_SCANNER_PRODUCT_ID'] ?? '0'),
  },
  cache: { staleAfterMs: Number(process.env['POS_CACHE_STALE_MS'] ?? 5 * 60_000) },
  register: { id: process.env['POS_REGISTER_ID'] ?? 'CAJA-1' },
  apiBaseUrl: process.env['POS_API_BASE_URL'] ?? '',
} as const;