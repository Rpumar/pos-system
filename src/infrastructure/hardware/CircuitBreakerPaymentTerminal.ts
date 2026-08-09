import { IPaymentTerminal, PaymentResult } from '../../application/ports/IPeripherals';
import { PeripheralEventBus } from './PeripheralEventBus';

export class CircuitBreakerPaymentTerminal implements IPaymentTerminal {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly inner: IPaymentTerminal,
    private readonly eventBus: PeripheralEventBus,
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 60_000
  ) {}

  async charge(amount: number): Promise<PaymentResult> {
    if (Date.now() < this.circuitOpenUntil) {
      return {
        status: 'DISCONNECTED',
        message: 'Terminal deshabilitado temporalmente. Use efectivo o aguarde.',
      };
    }

    const result = await this.inner.charge(amount);

    if (result.status === 'TIMEOUT' || result.status === 'DISCONNECTED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.circuitOpenUntil = Date.now() + this.cooldownMs;
        this.eventBus.emit('terminal:circuit-open', { until: this.circuitOpenUntil });
      }
    } else {
      // Cualquier respuesta válida (incluso REJECTED) resetea: el terminal responde.
      this.consecutiveFailures = 0;
      if (this.circuitOpenUntil > 0) {
        this.circuitOpenUntil = 0;
        this.eventBus.emit('terminal:reconnected', undefined);
      }
    }

    return result;
  }

  async reverseCharge(authCode: string, amount: number): Promise<PaymentResult> {
    return this.inner.reverseCharge(authCode, amount);
  }

  async cancelCurrentTransaction(): Promise<void> {
    return this.inner.cancelCurrentTransaction();
  }

  async isOnline(): Promise<boolean> {
    return Date.now() >= this.circuitOpenUntil && this.inner.isOnline();
  }

  /** Exposición del estado para tests y monitoreo. */
  get isOpen(): boolean { return Date.now() < this.circuitOpenUntil; }
  get failures(): number { return this.consecutiveFailures; }
}
