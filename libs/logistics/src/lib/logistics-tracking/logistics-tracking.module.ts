import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { LogisticsTrackingService } from './logistics-tracking.service';
import { LogisticsTrackingController } from './logistics-tracking.controller';
import { FleetTrackingGateway } from './fleet-tracking.gateway';
import { FleetPollerService } from './fleet-poller.service';
import { FleetAlertsService } from './fleet-alerts.service';
import { FleetAlertsScannerService } from './fleet-alerts-scanner.service';
import { TripBuilderService } from './trip-builder.service';
import { TripBuilderScannerService } from './trip-builder-scanner.service';
import { RouteAdherenceService } from './route-adherence.service';
import { FleetProductivityService } from './fleet-productivity.service';
import { MagniTrackingAdapter } from './magnitracking.adapter';
import { FLEET_PROVIDER_PORT } from './fleet-provider.port';

/**
 * LT — Rastreo de flota GPS. Adaptador del proveedor detrás de FLEET_PROVIDER_PORT
 * (hoy MagniTracking); cambiar de proveedor = cambiar solo el adapter.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [LogisticsTrackingController],
  providers: [
    LogisticsTrackingService,
    FleetTrackingGateway,
    FleetPollerService,
    FleetAlertsService,
    FleetAlertsScannerService,
    TripBuilderService,
    TripBuilderScannerService,
    RouteAdherenceService,
    FleetProductivityService,
    MagniTrackingAdapter,
    { provide: FLEET_PROVIDER_PORT, useExisting: MagniTrackingAdapter },
  ],
  exports: [LogisticsTrackingService, FleetAlertsService, TripBuilderService],
})
export class LogisticsTrackingModule {}
