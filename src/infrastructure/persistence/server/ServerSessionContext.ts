import { ApiClient } from '../../http/ApiClient';

export interface RegisterResolution {
  cajaId: string;
  sucursalId: string;
  cajaNombre: string;
}

/**
 * Estado de sesión compartido por los repositorios remotos del container
 * server: token, sucursal del usuario, resolución caja/sucursal por
 * nombre de registro, y el snapshot en memoria de turnos abiertos.
 */
export class ServerSessionContext {
  private cashierId: string | null = null;
  private sucursalId: string | null = null;
  private registerCache = new Map<string, RegisterResolution>();
  private shiftRegister = new Map<string, RegisterResolution>();
  private openShiftIds = new Set<string>();

  constructor(private readonly api: ApiClient) {}

  getApi(): ApiClient {
    return this.api;
  }

  setAuth(userId: string, sucursalId: string | null): void {
    this.cashierId = userId;
    if (sucursalId) this.sucursalId = sucursalId;
  }

  getCashierId(): string | null {
    return this.cashierId;
  }

  getSucursalId(): string | null {
    return this.sucursalId;
  }

  async resolveRegister(registerId: string): Promise<RegisterResolution> {
    const cached = this.registerCache.get(registerId);
    if (cached) return cached;

    const res = (await this.api.get<Record<string, unknown>>(
      `/mi/caja?nombre=${encodeURIComponent(registerId)}`
    )) as { caja_id: string; sucursal_id: string; caja_nombre: string };

    const resolution: RegisterResolution = {
      cajaId: String(res.caja_id),
      sucursalId: String(res.sucursal_id),
      cajaNombre: String(res.caja_nombre ?? registerId),
    };
    this.registerCache.set(registerId, resolution);
    if (!this.sucursalId) this.sucursalId = resolution.sucursalId;
    return resolution;
  }

  setShiftRegister(shiftId: string, resolution: RegisterResolution): void {
    this.shiftRegister.set(shiftId, resolution);
    if (!this.sucursalId) this.sucursalId = resolution.sucursalId;
  }

  getShiftRegister(shiftId: string): RegisterResolution | null {
    return this.shiftRegister.get(shiftId) ?? null;
  }

  isShiftOpen(shiftId: string): boolean {
    return this.openShiftIds.has(shiftId);
  }

  markShiftOpen(shiftId: string): void {
    this.openShiftIds.add(shiftId);
  }

  markShiftClosed(shiftId: string): void {
    this.openShiftIds.delete(shiftId);
  }
}
