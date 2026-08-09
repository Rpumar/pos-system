import { Product } from '../../../domain/entities/Product';
import { IProductRepository } from '../../../application/ports/IProductRepository';
import { ApiClient } from '../../http/ApiClient';
import { mapProduct } from '../../http/mappers';

type DTO = Record<string, unknown>;

const PAGE_SIZE = 1000;

export class ServerProductRepository implements IProductRepository {
  constructor(private readonly api: ApiClient) {}

  async findByBarcode(barcode: string): Promise<Product | null> {
    const scoped = await this.list(`?activo=true&search=${encodeURIComponent(barcode)}&limit=${PAGE_SIZE}`);
    const hit = scoped.find((p) => String(p['barcode']) === barcode);
    return hit ? mapProduct(hit as DTO) : null;
  }

  async findAllActive(): Promise<Product[]> {
    const rows = await this.api.get<unknown[]>(`/productos?activo=true&limit=${PAGE_SIZE}`);
    return (rows as DTO[]).map(mapProduct);
  }

  async findById(id: string): Promise<Product | null> {
    try {
      const dto = (await this.api.get<DTO>(`/productos/${id}`)) as DTO;
      return mapProduct(dto);
    } catch {
      return null;
    }
  }

  async findAll(): Promise<Product[]> {
    const rows = await this.api.get<unknown[]>(`/productos?limit=${PAGE_SIZE}`);
    return (rows as DTO[]).map(mapProduct);
  }

  async create(product: Omit<Product, 'id'>): Promise<Product> {
    const dto = (await this.api.post<DTO>('/productos', {
      sku: product.sku,
      barcode: product.barcode,
      nombre: product.name,
      precio: product.price,
      costo: 0,
      impuesto: 0,
      stock_central: product.stock,
    })) as DTO;
    return mapProduct(dto);
  }

  async update(id: string, changes: Partial<Omit<Product, 'id'>>): Promise<Product> {
    const body: Record<string, unknown> = {};
    if (changes.sku !== undefined) body['sku'] = changes.sku;
    if (changes.barcode !== undefined) body['barcode'] = changes.barcode;
    if (changes.name !== undefined) body['nombre'] = changes.name;
    if (changes.price !== undefined) body['precio'] = changes.price;
    if (changes.stock !== undefined) body['stock_central'] = changes.stock;

    const dto = (await this.api.put<DTO>(`/productos/${id}`, body)) as DTO;
    return mapProduct(dto);
  }

  async delete(id: string): Promise<void> {
    await this.api.delete(`/productos/${id}`);
  }

  async findBySku(sku: string): Promise<Product | null> {
    const scoped = await this.list(`?activo=true&search=${encodeURIComponent(sku)}&limit=${PAGE_SIZE}`);
    const hit = scoped.find((p) => String(p['sku']) === sku);
    return hit ? mapProduct(hit as DTO) : null;
  }

  private async list(query: string): Promise<DTO[]> {
    return (await this.api.get<unknown[]>(`/productos${query}`)) as DTO[];
  }
}