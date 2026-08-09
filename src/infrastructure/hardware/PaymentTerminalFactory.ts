import { IPaymentTerminal, PaymentStatus } from '../../application/ports/IPeripherals';
import { MockPaymentTerminal, MockBehavior } from './MockPaymentTerminal';
import { PeripheralEventBus } from './PeripheralEventBus';
import { CircuitBreakerPaymentTerminal } from './CircuitBreakerPaymentTerminal';
import { SerialPortPaymentTerminal, TerminalProtocolConfig, PaymentTerminalProtocol } from './SerialPortPaymentTerminal';

export type TerminalVendor = 'SERIAL' | 'MOCK';
export type TerminalProtocol = PaymentTerminalProtocol;

export interface TerminalConfig {
  vendor: TerminalVendor;
  protocol?: TerminalProtocol;
  portPath?: string;
  baudRate?: number;
  mockBehavior?: MockBehavior;
  merchantId?: string;
  terminalId?: string;
  timeoutMs?: number;
}

export class PaymentTerminalFactory {
  static create(config: TerminalConfig, eventBus: PeripheralEventBus): IPaymentTerminal {
    let inner: IPaymentTerminal;

    switch (config.vendor) {
      case 'SERIAL': {
        const protocolConfig: TerminalProtocolConfig = {
          protocol: config.protocol ?? 'GENERIC',
          portPath: config.portPath ?? '/dev/ttyUSB0',
          baudRate: config.baudRate ?? 9600,
          merchantId: config.merchantId,
          terminalId: config.terminalId,
          timeoutMs: config.timeoutMs,
          onStatusChange: (status: PaymentStatus) => {
            if (status === 'DISCONNECTED') {
              eventBus.emit('terminal:circuit-open', { until: Date.now() + 30_000 });
            } else if (status === 'APPROVED' || status === 'REJECTED') {
              eventBus.emit('terminal:reconnected', undefined);
            }
          },
        };
        inner = new SerialPortPaymentTerminal(protocolConfig);
        break;
      }
      case 'MOCK':
        inner = new MockPaymentTerminal(config.mockBehavior ?? 'APPROVE');
        break;
      default:
        throw new Error(`Vendor desconocido: ${(config as TerminalConfig).vendor}`);
    }

    return new CircuitBreakerPaymentTerminal(inner, eventBus);
  }
}