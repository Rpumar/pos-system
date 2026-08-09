export type PaymentMethod = 'CASH' | 'CARD';
export type SaleStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'VOIDED';

/**
 * Línea de detalle ya persistida. No confundir con CartItem (Módulo 1),
 * que vive en memoria mientras el cajero arma la compra.
 */
export class SaleDetail {
  constructor(
    public readonly productId: string,
    public readonly quantity: number,
    public readonly unitPrice: number,
    public readonly subtotal: number
  ) {}
}

/**
 * Entidad de dominio. Representa una venta ya confirmada (o en proceso
 * de confirmarse) en la base de datos del servidor local.
 */
export class Sale {
  constructor(
    public readonly id: string,
    public readonly shiftId: string,
    public readonly cashierId: string,
    public readonly details: SaleDetail[],
    public readonly total: number,
    public status: SaleStatus,
    public readonly paymentMethod?: PaymentMethod,
    public readonly authCode?: string,
    public readonly createdAt: Date = new Date(),
    public syncedAt?: Date
  ) {}

  get isSynced(): boolean {
    return this.syncedAt !== undefined;
  }
}
