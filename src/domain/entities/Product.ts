/**
 * Entidad de dominio. Representa un producto del catálogo.
 * No conoce SQL ni IndexedDB — eso es responsabilidad de los repositorios
 * en infrastructure/persistence.
 */
export class Product {
  constructor(
    public readonly id: string,
    public readonly sku: string,
    public readonly barcode: string,
    public readonly name: string,
    public price: number,
    public stock: number,
    public readonly active: boolean = true
  ) {}

  hasStockFor(quantity: number): boolean {
    return this.stock >= quantity;
  }
}
