import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TripBuilderService } from './trip-builder.service';

/**
 * LTV.0 — reconstruye viajes/paradas del día anterior cada madrugada (3:30 AM MX).
 * Guard de re-entrancy. Corre siempre (lee de la DB); si no hay data, no-op.
 */
@Injectable()
export class TripBuilderScannerService {
  private readonly logger = new Logger(TripBuilderScannerService.name);
  private running = false;

  constructor(private readonly trips: TripBuilderService) {}

  @Cron('0 30 3 * * *')
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Ayer en hora MX (offset fijo -06:00, sin DST desde 2022).
      const mxNow = new Date(Date.now() - 6 * 3600 * 1000);
      const y = new Date(mxNow.getTime() - 24 * 3600 * 1000);
      const day = y.toISOString().slice(0, 10);
      const res = await this.trips.buildForDate(day);
      this.logger.log(`nightly trips ${day}: ${res.length} vehículos reconstruidos`);
    } catch (e: any) {
      this.logger.error(`nightly trips falló: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
