/**
 * Entidad de dominio. Línea del carrito MIENTRAS el cajero compone la
 * venta — vive 100% en memoria (Módulo 1), nunca toca la base de datos
 * hasta que CommitSaleUseCase la persiste como SaleDetail.
 */
export class CartItem {
  constructor(
    public readonly productId: string,
    public readonly sku: string,
    public readonly name: string,
    public readonly unitPrice: number,
    public quantity: number
  ) {}

  get subtotal(): number {
    return this.unitPrice * this.quantity;
  }
}

/**
 * Entidad de dominio. Carrito mutable en memoria — deliberadamente no
 * inmutable: bajo escaneo continuo, reconstruir arrays inmutables en
 * cada item agregaría presión de GC innecesaria para un caso de uso
 * que ya es de alta frecuencia.
 */
export class Cart {
  private items = new Map<string, CartItem>();

  addItem(item: CartItem): void {
    const existing = this.items.get(item.productId);
    existing ? (existing.quantity += item.quantity) : this.items.set(item.productId, item);
  }

  updateQuantity(productId: string, delta: number): void {
    const item = this.items.get(productId);
    if (!item) throw new ProductNotInCartError(productId);
    item.quantity = Math.max(0, item.quantity + delta);
    if (item.quantity === 0) this.items.delete(productId);
  }

  removeItem(productId: string): void {
    this.items.delete(productId);
  }

  clear(): void {
    this.items.clear();
  }

  getItems(): CartItem[] {
    return Array.from(this.items.values());
  }

  get total(): number {
    return this.getItems().reduce((sum, item) => sum + item.subtotal, 0);
  }
}

export class ProductNotInCartError extends Error {
  constructor(productId: string) {
    super(`El producto ${productId} no está en el carrito`);
    this.name = 'ProductNotInCartError';
  }
}
