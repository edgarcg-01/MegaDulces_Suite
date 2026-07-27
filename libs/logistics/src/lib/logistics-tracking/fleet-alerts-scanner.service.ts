import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FleetAlertsService } from './fleet-alerts.service';

/**
 * LT.6 — Scanner de alertas de flota. Cada 5 min recorre los trackers y
 * abre/resuelve alertas persistidas (offline / velocidad). Guard de re-entrancy.
 * Corre siempre (lee de la DB, no del proveedor); si no hay trackers, no-op.
 */
@Injectable()
export class FleetAlertsScannerService {
  private readonly logger = new Logger(FleetAlertsScannerService.name);
  private running = false;

  constructor(private readonly alerts: FleetAlertsService) {}

  @Cron('0 */5 * * * *')
  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.alerts.scan();
    } catch (e: any) {
      this.logger.error(`scan falló: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
