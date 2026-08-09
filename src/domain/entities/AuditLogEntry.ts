/**
 * Entidad de dominio. Bitácora de acciones sensibles (anulaciones,
 * overrides de precio, retiros, intentos de login fallidos).
 * Diseñada para ser de solo-lectura una vez escrita.
 */
export class AuditLogEntry {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly action: string,
    public readonly entity?: string,
    public readonly entityId?: string,
    public readonly metadata?: Record<string, unknown>,
    public readonly createdAt: Date = new Date()
  ) {}
}
