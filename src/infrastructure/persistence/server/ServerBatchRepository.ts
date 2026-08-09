import {
  IBatchRepository,
  ExpirationAlert,
  classifyUrgency,
} from '../../../application/ports/IBatchRepository';
import { ApiClient } from '../../http/ApiClient';

type DTO = Record<string, unknown>;

export class ServerBatchRepository implements IBatchRepository {
  constructor(private readonly api: ApiClient) {}

  async findExpiringWithin(days: number): Promise<ExpirationAlert[]> {
    const rows = (await this.api.get<unknown[]>(
      `/productos/vencimientos?dias=${days}`
    )) as DTO[];
    return rows.map((r) => {
      const daysUntil = Number(r['dias_para_vencer'] ?? 0);
      return {
        batchId: String(r['id']),
        productId: String(r['producto_id']),
        productName: String(r['nombre'] ?? ''),
        sku: String(r['sku'] ?? ''),
        batchCode: String(r['codigo_lote'] ?? ''),
        quantity: Number(r['cantidad'] ?? 0),
        expirationDate: new Date(String(r['fecha_vencimiento'] ?? '')),
        daysUntilExpiration: daysUntil,
        urgency: classifyUrgency(daysUntil),
      };
    });
  }
}
