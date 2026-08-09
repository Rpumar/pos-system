import { User } from '../../domain/entities/User';
import { IUserRepository, IPasswordHasher, IAuditLogRepository } from '../ports/IAuthRepositories';
import { InvalidPinError, AccountLockedError } from '../errors/AuthErrors';

interface AttemptRecord {
  count: number;
  lockedUntil?: number;
}

export class AuthenticateCashierUseCase {
  // En memoria: el bloqueo es por proceso, no persistido.
  // Si el servidor se reinicia se resetea — aceptable para un entorno
  // de una sola caja local; para múltiples sucursales, persistir en BD.
  private attempts = new Map<string, AttemptRecord>();

  constructor(
    private readonly userRepository: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly auditLog: IAuditLogRepository,
    private readonly maxAttempts = 3,
    private readonly lockoutMs = 5 * 60_000
  ) {}

  async execute(userId: string, pin: string): Promise<User> {
    const record = this.attempts.get(userId);

    if (record?.lockedUntil && Date.now() < record.lockedUntil) {
      throw new AccountLockedError(new Date(record.lockedUntil));
    }

    const user = await this.userRepository.findById(userId);
    const valid = user?.active && await this.hasher.verify(pin, user.pinHash);

    if (!valid) {
      const count = (record?.count ?? 0) + 1;
      const lockedUntil = count >= this.maxAttempts ? Date.now() + this.lockoutMs : undefined;
      this.attempts.set(userId, { count, lockedUntil });

      await this.auditLog.record({
        userId,
        action: 'LOGIN_FAILED',
        metadata: { attempt: count, locked: !!lockedUntil },
      });

      throw new InvalidPinError();
    }

    this.attempts.delete(userId);
    await this.auditLog.record({ userId, action: 'LOGIN_SUCCESS' });
    return user!;
  }
}
