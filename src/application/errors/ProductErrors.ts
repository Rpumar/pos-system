export class ProductNotFoundError extends Error {
  constructor(public readonly barcode: string) {
    super(`Producto no encontrado para el código de barras: ${barcode}`);
    this.name = 'ProductNotFoundError';
  }
}

export class InsufficientStockError extends Error {
  constructor(public readonly sku: string, public readonly available: number, public readonly requested: number) {
    super(`Stock insuficiente para ${sku}: disponible ${available}, se pidieron ${requested}`);
    this.name = 'InsufficientStockError';
  }
}
