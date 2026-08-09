import { IThermalPrinter, PrinterStatus } from '../../application/ports/IPeripherals';
import { PeripheralEventBus } from './PeripheralEventBus';

export interface PrintJob {
  id: string;
  saleId: string;
  content: string;
  attempts: number;
}

export interface ILogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class PrintJobQueue {
  private queue: PrintJob[] = [];
  private processing = false;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly printer: IThermalPrinter,
    private readonly eventBus: PeripheralEventBus,
    private readonly logger: ILogger,
    { maxRetries = 3, retryDelayMs = 1000 } = {}
  ) {
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  /**
   * Encola el trabajo y retorna INMEDIATAMENTE.
   * El cajero puede atender al siguiente cliente mientras el ticket se imprime.
   */
  enqueue(job: Omit<PrintJob, 'attempts'>): void {
    this.queue.push({ ...job, attempts: 0 });
    // No await — intencionalmente fire-and-forget.
    void this.processNext();
  }

  getPendingCount(): number { return this.queue.length; }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const job = this.queue[0]!;

    try {
      // Verifica el estado de la impresora ANTES de intentar imprimir,
      // no después de fallar — permite un mensaje preciso al cajero.
      const status = await this.printer.getStatus();
      if (status !== 'READY') {
        if (status === 'OUT_OF_PAPER') this.eventBus.emit('printer:out-of-paper', undefined);
        else if (status === 'COVER_OPEN') this.eventBus.emit('printer:cover-open', undefined);
        else if (status === 'ERROR') this.eventBus.emit('printer:error', { message: 'Error de impresora' });
        throw new Error(`Impresora no lista: ${status}`);
      }

      await this.printer.print(job.content);
      this.queue.shift();
      this.eventBus.emit('printer:ready', undefined);
    } catch (error) {
      job.attempts++;
      this.logger.warn('Fallo de impresión', { saleId: job.saleId, attempt: job.attempts });

      if (job.attempts >= this.maxRetries) {
        this.queue.shift();
        this.logger.error('Ticket no impreso tras máximos reintentos', { saleId: job.saleId });
        this.eventBus.emit('printer:job-failed', { saleId: job.saleId });
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        // Backoff simple antes de reintentar: no colapsar la impresora con
        // requests consecutivos si hay un problema de papel/conexión.
        setTimeout(() => void this.processNext(), this.retryDelayMs);
      }
    }
  }
}
