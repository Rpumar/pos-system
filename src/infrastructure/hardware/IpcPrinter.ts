import { IThermalPrinter, PrinterStatus } from '../../application/ports/IPeripherals';
import { PeripheralEventBus } from './PeripheralEventBus';
import type { ElectronHardwarePrinterApi } from '../../electron-api';

/**
 * Adapter de impresora que delega en el proceso MAIN via IPC.
 *
 * El renderer corre con `contextIsolation: true` y no puede abrir puertos
 * serie (serialport es un módulo nativo de Node). El main process lo hace
 * y expone `window.electronAPI.hardware.printer`.
 *
 * Si el bridge no está disponible (build de navegador puro: `npm run dev`
 * sin electron, o tests), el container usa este printer como mock silencioso
 * para no romper la UI.
 */
export class IpcPrinter implements IThermalPrinter {
  private readonly api: ElectronHardwarePrinterApi | null =
    typeof window !== 'undefined' && window.electronAPI?.hardware?.printer
      ? window.electronAPI.hardware.printer
      : null;

  constructor(private readonly eventBus?: PeripheralEventBus) {}

  private emitEvent(type: 'printer:out-of-paper' | 'printer:ready' | 'printer:cover-open' | 'printer:error', payload?: unknown): void {
    this.eventBus?.emit(type, payload as never);
  }

  async getStatus(): Promise<PrinterStatus> {
    if (!this.api) return 'READY';
    try {
      const { status } = await this.api.status();
      if (status === 'OFFLINE') {
        this.emitEvent('printer:error', { message: 'Impresora sin conexión' });
        return 'OFFLINE';
      }
      if (status === 'OUT_OF_PAPER') {
        this.emitEvent('printer:out-of-paper', undefined);
        return 'OUT_OF_PAPER';
      }
      if (status === 'COVER_OPEN') {
        this.emitEvent('printer:cover-open', undefined);
        return 'COVER_OPEN';
      }
      this.emitEvent('printer:ready', undefined);
      return 'READY';
    } catch (error) {
      this.emitEvent('printer:error', { message: error instanceof Error ? error.message : 'Error de impresora' });
      return 'ERROR';
    }
  }

  async print(content: string): Promise<void> {
    if (!this.api) {
      console.log('[PRINTER:IPC-NO-DISPONIBLE]', content.slice(0, 120));
      return;
    }
    try {
      await this.api.print(content);
      this.emitEvent('printer:ready', undefined);
    } catch (error) {
      this.emitEvent('printer:error', { message: error instanceof Error ? error.message : 'Error de impresión' });
      throw error;
    }
  }

  async openCashDrawer(): Promise<void> {
    if (!this.api) return;
    await this.api.openCashDrawer();
  }
}