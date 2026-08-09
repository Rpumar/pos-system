import { AuthenticateCashierUseCase } from './AuthenticateCashierUseCase';
import { IAuditLogRepository } from '../ports/IAuthRepositories';
import { UnauthorizedActionError } from '../errors/AuthErrors';

export interface ISensitiveAction<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}

/**
 * Decorador genérico: envuelve cualquier caso de uso sensible exigiendo
 * una segunda autenticación de supervisor antes de ejecutarlo.
 *
 * No hay duplicación: una sola implementación protege anulaciones,
 * retiros de efectivo, overrides de precio, etc.
 */
export class SupervisorAuthorizationDecorator<TInput, TOutput> {
  constructor(
    private readonly inner: ISensitiveAction<TInput, TOutput>,
    private readonly authenticate: AuthenticateCashierUseCase,
    private readonly auditLog: IAuditLogRepository,
    private readonly actionName: string
  ) {}

  async execute(
    input: TInput,
    supervisorId: string,
    supervisorPin: string,
    requestedByUserId: string
  ): Promise<TOutput> {
    const supervisor = await this.authenticate.execute(supervisorId, supervisorPin);

    if (!supervisor.canAuthorizeSensitiveActions()) {
      throw new UnauthorizedActionError(this.actionName);
    }

    // Cuando el caso de uso registra QUIÉN autorizó (campo authorizedBy), se
    // propaga el ID interno del supervisor (UUID), no el email que tipeó la
    // cajera. Así el servidor puede validar el rol del autorizante en firme.
    let effectiveInput = input;
    if (typeof input === 'object' && input !== null && 'authorizedBy' in input) {
      effectiveInput = { ...input, authorizedBy: supervisor.id } as TInput;
    }

    const result = await this.inner.execute(effectiveInput);

    // Registro separado de QUIÉN pidió y QUIÉN autorizó —
    // distinción clave para auditar irregularidades.
    await this.auditLog.record({
      userId: requestedByUserId,
      action: this.actionName,
      metadata: { authorizedBy: supervisor.id, supervisorRole: supervisor.role },
    });

    return result;
  }
}
