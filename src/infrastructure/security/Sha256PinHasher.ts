import { createHash, randomBytes } from 'crypto';
import { IPasswordHasher } from '../../application/ports/IAuthRepositories';

/**
 * Hasher de desarrollo usando SHA-256 con salt aleatorio.
 * En producción reemplazar por bcrypt o argon2 via npm.
 * La interfaz IPasswordHasher permite el swap sin tocar los casos de uso.
 *
 * Formato del hash guardado: `sha256:${salt}:${hash}`
 */
export class Sha256PinHasher implements IPasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(salt + plain).digest('hex');
    return `sha256:${salt}:${hash}`;
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    const [, salt, expectedHash] = stored.split(':');
    if (!salt || !expectedHash) return false;
    const actualHash = createHash('sha256').update(salt + plain).digest('hex');
    return actualHash === expectedHash;
  }
}
