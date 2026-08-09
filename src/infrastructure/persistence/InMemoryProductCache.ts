import { IProductRepository } from '../../application/ports/IProductRepository';
import { Product } from '../../domain/entities/Product';

export class InMemoryProductCache implements IProductRepository {
  private byBarcode = new Map<string, Product>();
  private lastWarmedAt = 0;
  private readonly staleAfterMs: number;

  constructor(private readonly source: IProductRepository, staleAfterMs = 5 * 60_000) {
    this.staleAfterMs = staleAfterMs;
  }

  async warmUp(): Promise<void> {
    const products = await this.source.findAllActive();
    this.byBarcode.clear();
    for (const p of products) this.byBarcode.set(p.barcode, p);
    this.lastWarmedAt = Date.now();
    console.log(`[Cache] ${this.byBarcode.size} productos cargados en RAM`);
  }

  // Read methods (cached)
  async findByBarcode(barcode: string): Promise<Product | null> {
    if (this.isStale()) {
      this.warmUp().catch((e) => console.warn('[Cache] Error al refrescar:', e));
    }
    return this.byBarcode.get(barcode) ?? null;
  }

  async findAllActive(): Promise<Product[]> {
    if (this.isStale()) await this.warmUp();
    return Array.from(this.byBarcode.values());
  }

  // Write methods (delegate to source, invalidate cache)
  async findById(id: string): Promise<Product | null> {
    return this.source.findById(id);
  }

  async findAll(): Promise<Product[]> {
    return this.source.findAll();
  }

  async findBySku(sku: string): Promise<Product | null> {
    return this.source.findBySku(sku);
  }

  async create(product: Omit<Product, 'id'>): Promise<Product> {
    const result = await this.source.create(product);
    this.invalidate();
    return result;
  }

  async update(id: string, changes: Partial<Omit<Product, 'id'>>): Promise<Product> {
    const result = await this.source.update(id, changes);
    this.invalidate();
    return result;
  }

  async delete(id: string): Promise<void> {
    await this.source.delete(id);
    this.invalidate();
  }

  invalidate(): void { this.lastWarmedAt = 0; }
  private isStale(): boolean { return Date.now() - this.lastWarmedAt > this.staleAfterMs; }
}