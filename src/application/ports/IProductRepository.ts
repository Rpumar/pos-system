import { Product } from '../../domain/entities/Product';

/**
 * Repositorio de productos. Separación intencional:
 * - Lectura (findByBarcode, findAllActive): usada por checkout, cacheable.
 * - Escritura (create, update, delete): solo admin/supervisor, no cacheable.
 * El descuento real de stock NUNCA pasa por aquí — eso es
 * responsabilidad exclusiva de ITransaction.decrementStock (Módulo 3).
 */
export interface IProductRepository {
  // Lectura (checkout, cache)
  findByBarcode(barcode: string): Promise<Product | null>;
  findAllActive(): Promise<Product[]>;

  // Escritura (gestión de catálogo)
  findById(id: string): Promise<Product | null>;
  findAll(): Promise<Product[]>;
  create(product: Omit<Product, 'id'>): Promise<Product>;
  update(id: string, changes: Partial<Omit<Product, 'id'>>): Promise<Product>;
  delete(id: string): Promise<void>;
  findBySku(sku: string): Promise<Product | null>;
}
