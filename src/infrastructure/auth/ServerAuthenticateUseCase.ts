import { User } from '../../domain/entities/User';
import { AuthenticateCashierUseCase } from '../../application/use-cases/AuthenticateCashierUseCase';
import {
  IPasswordHasher,
  IUserRepository,
  IAuditLogRepository,
} from '../../application/ports/IAuthRepositories';
import { InvalidPinError } from '../../application/errors/AuthErrors';
import { ApiClient, ApiError } from '../http/ApiClient';
import { mapUser } from '../http/mappers';
import { ServerSessionContext } from '../persistence/server/ServerSessionContext';

type DTO = Record<string, unknown>;

const stubHasher: IPasswordHasher = {
  hash: async (p) => p,
  verify: async (_p, _h) => true,
};

const stubUserRepo: IUserRepository = {
  findById: async () => null,
  findAll: async () => [],
};

const stubAudit: IAuditLogRepository = {
  record: async () => undefined,
};

/**
 * Autenticación contra el servidor real. Extiende AuthenticateCashierUseCase
 * para conservar la firma (userId, pin) que usa toda la UI; acá el
 * identificador es el email del usuario.
 */
export class ServerAuthenticateUseCase extends AuthenticateCashierUseCase {
  constructor(
    private readonly api: ApiClient,
    private readonly ctx: ServerSessionContext,
    private readonly onAuthenticated?: (token: string, user: User) => void
  ) {
    super(stubUserRepo, stubHasher, stubAudit);
  }

  override async execute(identifier: string, pin: string): Promise<User> {
    let res: DTO;
    try {
      res = (await this.api.post<DTO>('/auth/login', {
        email: identifier.trim(),
        pin,
      })) as DTO;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new InvalidPinError();
      throw e;
    }

    this.api.setToken(String(res['token'] ?? ''));
    const userDto = (res['user'] ?? {}) as DTO;
    const user = mapUser(userDto);
    this.ctx.setAuth(user.id, String(userDto['sucursal_id'] ?? '') || null);
    this.onAuthenticated?.(String(res['token'] ?? ''), user);
    return user;
  }
}
