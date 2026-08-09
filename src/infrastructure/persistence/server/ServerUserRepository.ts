import { User } from '../../../domain/entities/User';
import { IUserRepository } from '../../../application/ports/IAuthRepositories';

/**
 * En modo servidor el login es remoto (POST /api/auth/login); el catálogo
 * de usuarios en memoria no se usa. Implementación vacía para cumplir el
 * contrato de IUserRepository.
 */
export class ServerUserRepository implements IUserRepository {
  async findById(_id: string): Promise<User | null> {
    return null;
  }

  async findAll(): Promise<User[]> {
    return [];
  }
}
