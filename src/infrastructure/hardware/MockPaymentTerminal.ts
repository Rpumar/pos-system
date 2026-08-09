import { IPaymentTerminal, PaymentResult } from '../../application/ports/IPeripherals';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type MockBehavior = 'APPROVE' | 'REJECT' | 'TIMEOUT' | 'DISCONNECT';

export class MockPaymentTerminal implements IPaymentTerminal {
  constructor(
    private behavior: MockBehavior = 'APPROVE',
    private latencyMs = 1500
  ) {}

  async charge(amount: number): Promise<PaymentResult> {
    await delay(this.latencyMs);
    switch (this.behavior) {
      case 'APPROVE':
        return { status: 'APPROVED', authCode: `MOCK-${Date.now()}`, message: `Aprobado $${amount}` };
      case 'REJECT':
        return { status: 'REJECTED', message: 'Fondos insuficientes (mock)' };
      case 'TIMEOUT':
        return { status: 'TIMEOUT', message: 'Sin respuesta del terminal (mock)' };
      case 'DISCONNECT':
        return { status: 'DISCONNECTED', message: 'Terminal desconectado (mock)' };
    }
  }

  async reverseCharge(_authCode: string, amount: number): Promise<PaymentResult> {
    await delay(500);
    return { status: 'APPROVED', message: `Reversa de $${amount} aplicada (mock)` };
  }

  async cancelCurrentTransaction(): Promise<void> { await delay(100); }
  async isOnline(): Promise<boolean> { return this.behavior !== 'DISCONNECT'; }

  /** Permite cambiar el comportamiento entre tests sin crear instancias nuevas. */
  setBehavior(b: MockBehavior): void { this.behavior = b; }
}
