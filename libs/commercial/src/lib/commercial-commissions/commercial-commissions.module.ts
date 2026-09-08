import { Module } from '@nestjs/common';
import { CommercialCommissionsService } from './commercial-commissions.service';
import { CommercialCommissionsController } from './commercial-commissions.controller';

/** RD.6 — motor de comisiones de Ruta Directa. Ver el header del service. */
@Module({
  controllers: [CommercialCommissionsController],
  providers: [CommercialCommissionsService],
  exports: [CommercialCommissionsService],
})
export class CommercialCommissionsModule {}
