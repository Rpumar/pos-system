export type ExpirationUrgency = 'EXPIRED' | 'CRITICAL' | 'WARNING' | 'NOTICE';

export interface ExpirationAlert {
  batchId: string;
  productId: string;
  productName: string;
  sku: string;
  batchCode: string;
  quantity: number;
  expirationDate: Date;
  daysUntilExpiration: number;
  urgency: ExpirationUrgency;
}

export interface IBatchRepository {
  findExpiringWithin(days: number): Promise<ExpirationAlert[]>;
}

/**
 * EXPIRED: ya venció. CRITICAL: vence en 3 días o menos.
 * WARNING: vence en 7 días o menos. NOTICE: dentro del horizonte
 * consultado pero sin urgencia inmediata.
 */
export function classifyUrgency(days: number): ExpirationUrgency {
  if (days < 0) return 'EXPIRED';
  if (days <= 3) return 'CRITICAL';
  if (days <= 7) return 'WARNING';
  return 'NOTICE';
}
