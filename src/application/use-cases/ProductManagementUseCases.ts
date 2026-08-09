import { IProductRepository } from '../ports/IProductRepository';
import { Product } from '../../domain/entities/Product';

export class ProductNotFoundError extends Error {
  constructor(public readonly identifier: string) {
    super(`Producto no encontrado: ${identifier}`);
    this.name = 'ProductNotFoundError';
  }
}

export class DuplicateSkuError extends Error {
  constructor(public readonly sku: string) {
    super(`SKU duplicado: ${sku}`);
    this.name = 'DuplicateSkuError';
  }
}

export class DuplicateBarcodeError extends Error {
  constructor(public readonly barcode: string) {
    super(`Código de barras duplicado: ${barcode}`);
    this.name = 'DuplicateBarcodeError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

interface ProductInput {
  sku: string;
  barcode: string;
  name: string;
  price: number;
  stock?: number;
  active?: boolean;
}

function validateProduct(input: ProductInput): void {
  if (!input.sku?.trim()) throw new ValidationError('SKU es obligatorio');
  if (!input.barcode?.trim()) throw new ValidationError('Código de barras es obligatorio');
  if (!input.name?.trim()) throw new ValidationError('Nombre es obligatorio');
  if (input.price < 0) throw new ValidationError('Precio no puede ser negativo');
  if ((input.stock ?? 0) < 0) throw new ValidationError('Stock no puede ser negativo');
}

export class CreateProductUseCase {
  constructor(private readonly repo: IProductRepository) {}

  async execute(input: ProductInput): Promise<Product> {
    validateProduct(input);

    const existingSku = await this.repo.findBySku(input.sku);
    if (existingSku) throw new DuplicateSkuError(input.sku);

    const existingBarcode = await this.repo.findByBarcode(input.barcode);
    if (existingBarcode) throw new DuplicateBarcodeError(input.barcode);

    const product = new Product(
      '', // id se asigna en repo
      input.sku.trim().toUpperCase(),
      input.barcode.trim(),
      input.name.trim(),
      input.price,
      input.stock ?? 0,
      input.active ?? true
    );

    return this.repo.create(product);
  }
}

export class UpdateProductUseCase {
  constructor(private readonly repo: IProductRepository) {}

  async execute(id: string, changes: Partial<ProductInput>): Promise<Product> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new ProductNotFoundError(id);

    if (changes.sku !== undefined && changes.sku !== existing.sku) {
      const conflict = await this.repo.findBySku(changes.sku);
      if (conflict) throw new DuplicateSkuError(changes.sku);
    }

    if (changes.barcode !== undefined && changes.barcode !== existing.barcode) {
      const conflict = await this.repo.findByBarcode(changes.barcode);
      if (conflict) throw new DuplicateBarcodeError(changes.barcode);
    }

    if (changes.price !== undefined && changes.price < 0) {
      throw new ValidationError('Precio no puede ser negativo');
    }
    if (changes.stock !== undefined && changes.stock < 0) {
      throw new ValidationError('Stock no puede ser negativo');
    }

    return this.repo.update(id, changes);
  }
}

export class DeleteProductUseCase {
  constructor(private readonly repo: IProductRepository) {}

  async execute(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new ProductNotFoundError(id);
    await this.repo.delete(id);
  }
}

export class ListProductsUseCase {
  constructor(private readonly repo: IProductRepository) {}

  async execute(includeInactive = false): Promise<Product[]> {
    if (includeInactive) return this.repo.findAll();
    return this.repo.findAllActive();
  }
}

export class ImportProductsCsvUseCase {
  constructor(private readonly repo: IProductRepository) {}

  async execute(csvContent: string): Promise<{ created: number; errors: string[] }> {
    const lines = csvContent.trim().split('\n');
    if (lines.length < 2) throw new ValidationError('CSV vacío o solo cabecera');

    const headerLine = lines[0];
    if (!headerLine) throw new ValidationError('Cabecera vacía');

    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());
    const required = ['sku', 'barcode', 'name', 'price'];
    for (const req of required) {
      if (!headers.includes(req)) throw new ValidationError(`Falta columna requerida: ${req}`);
    }

    const skuIdx = headers.indexOf('sku');
    const barcodeIdx = headers.indexOf('barcode');
    const nameIdx = headers.indexOf('name');
    const priceIdx = headers.indexOf('price');
    const stockIdx = headers.indexOf('stock');
    const activeIdx = headers.indexOf('active');

    // Required columns are guaranteed to exist (validated above)
    const skuCol = skuIdx >= 0 ? skuIdx : 0;
    const barcodeCol = barcodeIdx >= 0 ? barcodeIdx : 0;
    const nameCol = nameIdx >= 0 ? nameIdx : 0;
    const priceCol = priceIdx >= 0 ? priceIdx : 0;

    let created = 0;
    const errors: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split(',').map(c => c.trim());
      if (cols.length < required.length) {
        errors.push(`Línea ${i + 1}: columnas insuficientes`);
        continue;
      }

      try {
        const input: ProductInput = {
          sku: cols[skuCol] ?? '',
          barcode: cols[barcodeCol] ?? '',
          name: cols[nameCol] ?? '',
          price: parseFloat(cols[priceCol] ?? '0'),
          stock: stockIdx >= 0 ? parseInt(cols[stockIdx] ?? '0', 10) : 0,
          active: activeIdx >= 0 ? (cols[activeIdx] ?? 'true').toLowerCase() === 'true' : true,
        };
        await new CreateProductUseCase(this.repo).execute(input);
        created++;
      } catch (e) {
        errors.push(`Línea ${i + 1}: ${e instanceof Error ? e.message : 'Error desconocido'}`);
      }
    }

    return { created, errors };
  }
}