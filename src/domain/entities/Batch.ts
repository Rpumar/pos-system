/**
 * Entidad de dominio. Un lote físico de un producto con su propia fecha
 * de vencimiento. Varios lotes del mismo producto pueden coexistir
 * (Módulo 4: consumo FEFO — First-Expired, First-Out).
 */
export class Batch {
  constructor(
    public readonly id: string,
    public readonly productId: string,
    public readonly batchCode: string,
    public quantity: number,
    public readonly expirationDate: Date
  ) {}

  daysUntilExpiration(reference: Date = new Date()): number {
    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.floor((this.expirationDate.getTime() - reference.getTime()) / msPerDay);
  }

  isExpired(reference: Date = new Date()): boolean {
    return this.daysUntilExpiration(reference) < 0;
  }
}
