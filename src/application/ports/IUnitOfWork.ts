import { CartItem } from '../../domain/entities/Cart';

export interface SaleData {
  shiftId: string;
  cashierId: string;
  total: number;
  method: 'CASH' | 'CARD';
  authCode?: string;
  status: 'PAID';
}

export interface StockMovementData {
  productId: string;
  delta: number;
  reason: 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN';
  referenceId?: string;
  batchDetail?: BatchConsumption[];
}

export interface BatchConsumption {
  batchId: string;
  batchCode: string;
  quantityTaken: number;
}

export interface CashMovementData {
  shiftId: string;
  type: 'SALE_CASH' | 'WITHDRAWAL' | 'DEPOSIT' | 'REFUND';
  amount: number;
  referenceId?: string;
}

/**
 * Operaciones disponibles DENTRO de una transacción atómica.
 *
 * Importante: estos métodos son síncronos a propósito. Motores embebidos
 * como SQLite ejecutan transacciones de forma síncrona para garantizar
 * atomicidad real sin el overhead de locks asíncronos — el async-first
 * del resto del sistema se mantiene en la capa que envuelve a execute(),
 * no acá adentro.
 */
export interface SaleRow {
  id: string;
  shiftId: string;
  paymentMethod: 'CASH' | 'CARD';
  total: number;
  details: Array<{ productId: string; quantity: number }>;
}

export interface ITransaction {
  findOpenShift(shiftId: string): { id: string; status: string } | null;
  findSaleById(saleId: string): SaleRow | null;
  voidSale(saleId: string, reason?: string): void;
  decrementStock(productId: string, quantity: number): boolean;
  consumeBatchesFefo(productId: string, quantity: number): BatchConsumption[];
  incrementStock(productId: string, quantity: number): void;
  insertBatch(data: { productId: string; batchCode: string; quantity: number; expirationDate: Date }): string;
  insertSale(data: SaleData): string;
  insertSaleDetails(saleId: string, items: CartItem[]): void;
  insertStockMovement(m: StockMovementData): void;
  insertCashMovement(m: CashMovementData): void;
}

export interface IUnitOfWork {
  execute<T>(work: (tx: ITransaction) => T): Promise<T>;
}
