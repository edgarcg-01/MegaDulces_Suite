import { Module } from '@nestjs/common';
import { LogisticsGuidesService } from './logistics-guides.service';
import { LogisticsGuidesController } from './logistics-guides.controller';
import { LogisticsErpShipmentsModule } from '../logistics-erp-shipments/logistics-erp-shipments.module';

// EMB.22 — importa el módulo del ERP sólo para LEER la tarifa del viaje de Kepler al completar la guía.
@Module({
  imports: [LogisticsErpShipmentsModule],
  controllers: [LogisticsGuidesController],
  providers: [LogisticsGuidesService],
  exports: [LogisticsGuidesService],
})
export class LogisticsGuidesModule {}
