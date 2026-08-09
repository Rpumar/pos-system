import { IPaymentTerminal, PaymentResult } from '../ports/IPeripherals';
import { IUnitOfWork } from '../ports/IUnitOfWork';
import { PrintJobQueue } from '../../infrastructure/hardware/PrintJobQueue';
import { Cart } from '../../domain/entities/Cart';
import { Sale } from '../../domain/entities/Sale';
import { CommitSaleUseCase } from './CommitSaleUseCase';
import { StockConflictError } from '../errors/StockErrors';

// ── ProcessPaymentUseCase ─────────────────────────────────────────────────────

export interface ProcessPaymentResult {
  paymentResult: PaymentResult;
}

export class ProcessPaymentUseCase {
  constructor(private readonly terminal: IPaymentTerminal) {}

  async execute(method: 'CASH' | 'CARD', amount: number): Promise<PaymentResult> {
    if (method === 'CASH') {
      return { status: 'APPROVED', message: 'Pago en efectivo' };
    }
    // El await libera el event loop mientras el terminal responde (hasta 30s).
    // La UI puede seguir procesando eventos (ej. ESC para cancelar) en ese tiempo.
    return this.terminal.charge(amount);
  }
}

// ── FinalizeSaleUseCase ───────────────────────────────────────────────────────

export type FinalizeSaleResult =
  | { success: true; sale: Sale }
  | { success: false; reason: string; reversed: boolean };

export class FinalizeSaleUseCase {
  constructor(
    private readonly processPayment: ProcessPaymentUseCase,
    private readonly commitSale: CommitSaleUseCase,
    private readonly printQueue: PrintJobQueue,
    private readonly terminal: IPaymentTerminal
  ) {}

  async execute(
    cart: Cart,
    shiftId: string,
    cashierId: string,
    method: 'CASH' | 'CARD'
  ): Promise<FinalizeSaleResult> {
    const paymentResult = await this.processPayment.execute(method, cart.total);

    if (paymentResult.status !== 'APPROVED') {
      return { success: false, reason: paymentResult.message, reversed: false };
    }

    try {
      const sale = await this.commitSale.execute(
        cart, shiftId, cashierId, method, paymentResult.authCode
      );

      // Fire-and-forget: el cajero no espera la impresión.
      this.printQueue.enqueue({
        id: crypto.randomUUID(),
        saleId: sale.id,
        content: buildReceiptContent(sale),
      });

      return { success: true, sale };
    } catch (error) {
      // El cobro fue exitoso pero el commit falló (ej. stock agotado en el ínterin).
      // Hay que revertir el dinero retenido en la tarjeta — nunca cobrar sin vender.
      if (method === 'CARD' && paymentResult.authCode) {
        await this.terminal.reverseCharge(paymentResult.authCode, cart.total);
      }

      if (error instanceof StockConflictError) {
        return {
          success: false,
          reason: `Producto agotado: ${error.sku}. El cobro fue anulado automáticamente.`,
          reversed: method === 'CARD',
        };
      }
      throw error; // error inesperado → que suba para logging global
    }
  }
}

// ── Helper de ticket ──────────────────────────────────────────────────────────

function buildReceiptContent(sale: Sale): string {
  const lines = [
    '==============================',
    '         SISTEMA POS          ',
    '==============================',
    `Venta #: ${sale.id}`,
    `Fecha:   ${sale.createdAt.toLocaleString('es-UY')}`,
    `Método:  ${sale.paymentMethod === 'CARD' ? 'Tarjeta' : 'Efectivo'}`,
    sale.authCode ? `Auth:    ${sale.authCode}` : '',
    '------------------------------',
    ...sale.details.map(
      (d) => `${d.quantity}x  $${d.unitPrice.toFixed(2).padStart(8)}  $${d.subtotal.toFixed(2).padStart(9)}`
    ),
    '------------------------------',
    `TOTAL:   $${sale.total.toFixed(2)}`,
    '==============================',
    '      ¡Gracias por su compra! ',
    '==============================',
  ].filter(Boolean);

  return lines.join('\n');
}
