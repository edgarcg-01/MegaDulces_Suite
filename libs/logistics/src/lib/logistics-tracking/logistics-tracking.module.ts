import { Module } from '@nestjs/common';
import { LogisticsTrackingService } from './logistics-tracking.service';
import { LogisticsTrackingController } from './logistics-tracking.controller';
import { FleetPollerService } from './fleet-poller.service';
import { FleetAlertsService } from './fleet-alerts.service';
import { FleetAlertsScannerService } from './fleet-alerts-scanner.service';
import { MagniTrackingAdapter } from './magnitracking.adapter';
import { FLEET_PROVIDER_PORT } from './fleet-provider.port';

/**
 * LT — Rastreo de flota GPS. Adaptador del proveedor detrás de FLEET_PROVIDER_PORT
 * (hoy MagniTracking); cambiar de proveedor = cambiar solo el adapter.
 */
@Module({
  controllers: [LogisticsTrackingController],
  providers: [
    LogisticsTrackingService,
    FleetPollerService,
    FleetAlertsService,
    FleetAlertsScannerService,
    MagniTrackingAdapter,
    { provide: FLEET_PROVIDER_PORT, useExisting: MagniTrackingAdapter },
  ],
  exports: [LogisticsTrackingService, FleetAlertsService],
})
export class LogisticsTrackingModule {}
