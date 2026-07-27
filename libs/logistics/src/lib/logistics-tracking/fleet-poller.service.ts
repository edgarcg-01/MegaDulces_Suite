import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LogisticsTrackingService } from './logistics-tracking.service';

/**
 * LT.1 — Poller: cada minuto trae la flota del proveedor y la persiste.
 * Guard de re-entrancy (si una corrida sigue activa, skip). No corre si el
 * proveedor no tiene credenciales (env ausente) → cero ruido en local.
 */
@Injectable()
export class FleetPollerService {
  private readonly logger = new Logger(FleetPollerService.name);
  private running = false;

  constructor(private readonly tracking: LogisticsTrackingService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll(): Promise<void> {
    if (!this.tracking.isProviderConfigured()) return;
    if (this.running) {
      this.logger.warn('Skip poll: corrida anterior aún activa');
      return;
    }
    this.running = true;
    try {
      await this.tracking.sync();
    } catch (e: any) {
      this.logger.error(`poll falló: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
