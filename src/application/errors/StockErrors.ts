/**
 * Se lanza cuando el descuento atómico de products.stock falla porque
 * no había suficiente cantidad disponible en el momento exacto del
 * commit (alguien más se la llevó primero).
 */
export class StockConflictError extends Error {
  constructor(public readonly sku: string, public readonly requested: number) {
    super(`Stock insuficiente para ${sku} (se pidieron ${requested} unidades)`);
    this.name = 'StockConflictError';
  }
}

/**
 * Se lanza cuando products.stock decía que había cantidad suficiente,
 * pero la suma real de batches.quantity no la cubre. Esto NUNCA debería
 * pasar si el invariante stock === SUM(batches.quantity) se mantiene
 * siempre — si aparece, hay datos desincronizados y hay que frenar la
 * venta, no completarla con información inconsistente.
 */
export class InsufficientBatchCoverageError extends Error {
  constructor(
    public readonly productId: string,
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Lotes insuficientes para producto ${productId}: pidió ${requested}, ` +
      `los lotes solo cubren ${available}. Verificar sincronización de inventario.`
    );
    this.name = 'InsufficientBatchCoverageError';
  }
}

/** Se lanza si se intenta confirmar una venta sin un turno de caja abierto (Módulo 6). */
export class NoActiveShiftError extends Error {
  constructor(shiftId: string) {
    super(`No hay turno abierto con id ${shiftId} para registrar la venta`);
    this.name = 'NoActiveShiftError';
  }
}
