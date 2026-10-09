import { Module } from '@nestjs/common';
import { RouteProfitService } from './route-profit.service';
import { CommercialRouteProfitController } from './commercial-route-profit.controller';

/** `[RD.57]` — Rentabilidad de Ruta Directa. Ver el header del service. */
@Module({
  controllers: [CommercialRouteProfitController],
  providers: [RouteProfitService],
  exports: [RouteProfitService],
})
export class CommercialRouteProfitModule {}
