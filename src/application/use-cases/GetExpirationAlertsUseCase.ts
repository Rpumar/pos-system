import { IBatchRepository, ExpirationAlert, ExpirationUrgency } from '../ports/IBatchRepository';

export type ExpirationAlertsByUrgency = Record<ExpirationUrgency, ExpirationAlert[]>;

/**
 * Trae los lotes que vencen dentro del horizonte pedido y los agrupa
 * por urgencia. La clasificación se calcula acá, no en la UI, para que
 * cualquier pantalla (web, terminal, reporte impreso) la reciba ya lista.
 */
export class GetExpirationAlertsUseCase {
  constructor(private readonly batchRepository: IBatchRepository) {}

  async execute(horizonDays = 30): Promise<ExpirationAlertsByUrgency> {
    const alerts = await this.batchRepository.findExpiringWithin(horizonDays);

    return {
      EXPIRED: alerts.filter((a) => a.urgency === 'EXPIRED'),
      CRITICAL: alerts.filter((a) => a.urgency === 'CRITICAL'),
      WARNING: alerts.filter((a) => a.urgency === 'WARNING'),
      NOTICE: alerts.filter((a) => a.urgency === 'NOTICE'),
    };
  }
}
