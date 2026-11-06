import { Module } from '@nestjs/common';
import { RouteProfitService } from './route-profit.service';
import { CommercialRouteProfitController } from './commercial-route-profit.controller';
import { TlmkTripsService } from './tlmk-trips.service';

/** `[RD.57]` — Rentabilidad de Ruta Directa. Ver el header del service. */
@Module({
  controllers: [CommercialRouteProfitController],
  providers: [RouteProfitService, TlmkTripsService],
  exports: [RouteProfitService],
})
export class CommercialRouteProfitModule {}
