export type ShiftStatus = 'OPEN' | 'CLOSED';

/**
 * Entidad de dominio. Ninguna venta puede registrarse sin un Shift
 * en estado OPEN (Módulo 6). El arqueo se completa al cerrar.
 */
export class Shift {
  constructor(
    public readonly id: string,
    public readonly cashierId: string,
    public readonly registerId: string,
    public readonly openingAmount: number,
    public status: ShiftStatus,
    public readonly openedAt: Date,
    public expectedCash?: number,
    public countedCash?: number,
    public difference?: number,
    public closedAt?: Date
  ) {}

  isOpen(): boolean {
    return this.status === 'OPEN';
  }
}
