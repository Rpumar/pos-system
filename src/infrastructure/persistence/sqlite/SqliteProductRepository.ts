import type Database from 'better-sqlite3';
import { IProductRepository } from '../../../application/ports/IProductRepository';
import { Product } from '../../../domain/entities/Product';

interface ProductRow {
  id: string;
  sku: string;
  barcode: string;
  name: string;
  price: number;
  stock: number;
  active: number;
}

function toDomain(row: ProductRow): Product {
  return new Product(row.id, row.sku, row.barcode, row.name, row.price, row.stock, row.active === 1);
}

export class SqliteProductRepository implements IProductRepository {
  constructor(private readonly db: Database.Database) {}

  async findByBarcode(barcode: string): Promise<Product | null> {
    const row = this.db
      .prepare('SELECT * FROM products WHERE barcode = ? AND active = 1')
      .get(barcode) as ProductRow | undefined;
    return row ? toDomain(row) : null;
  }

  async findAllActive(): Promise<Product[]> {
    const rows = this.db.prepare('SELECT * FROM products WHERE active = 1').all() as ProductRow[];
    return rows.map(toDomain);
  }

  async findById(id: string): Promise<Product | null> {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined;
    return row ? toDomain(row) : null;
  }

  async findAll(): Promise<Product[]> {
    const rows = this.db.prepare('SELECT * FROM products ORDER BY name').all() as ProductRow[];
    return rows.map(toDomain);
  }

  async findBySku(sku: string): Promise<Product | null> {
    const row = this.db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as ProductRow | undefined;
    return row ? toDomain(row) : null;
  }

  async create(product: Omit<Product, 'id'>): Promise<Product> {
    const stmt = this.db.prepare(
      `INSERT INTO products (sku, barcode, name, price, stock, active)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      product.sku,
      product.barcode,
      product.name,
      product.price,
      product.stock,
      product.active ? 1 : 0
    );
    const newId = String(info.lastInsertRowid);
    return new Product(newId, product.sku, product.barcode, product.name, product.price, product.stock, product.active);
  }

  async update(id: string, changes: Partial<Omit<Product, 'id'>>): Promise<Product> {
    const fields: string[] = [];
    const values: any[] = [];

    if (changes.sku !== undefined) { fields.push('sku = ?'); values.push(changes.sku); }
    if (changes.barcode !== undefined) { fields.push('barcode = ?'); values.push(changes.barcode); }
    if (changes.name !== undefined) { fields.push('name = ?'); values.push(changes.name); }
    if (changes.price !== undefined) { fields.push('price = ?'); values.push(changes.price); }
    if (changes.stock !== undefined) { fields.push('stock = ?'); values.push(changes.stock); }
    if (changes.active !== undefined) { fields.push('active = ?'); values.push(changes.active ? 1 : 0); }

    if (fields.length === 0) {
      const current = await this.findById(id);
      if (!current) throw new Error('Producto no encontrado');
      return current;
    }

    fields.push('updated_at = datetime(\'now\')');
    values.push(id);

    this.db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = await this.findById(id);
    if (!updated) throw new Error('Producto no encontrado tras actualización');
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM products WHERE id = ?').run(id);
  }
}