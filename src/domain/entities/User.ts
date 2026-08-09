export type UserRole = 'CASHIER' | 'SUPERVISOR' | 'ADMIN';

/**
 * Entidad de dominio. pinHash llega ya hasheado desde infrastructure;
 * el dominio nunca ve ni manipula el PIN en texto plano.
 */
export class User {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly pinHash: string,
    public readonly role: UserRole,
    public readonly active: boolean = true
  ) {}

  canAuthorizeSensitiveActions(): boolean {
    return this.role === 'SUPERVISOR' || this.role === 'ADMIN';
  }
}
