import { Module } from '@nestjs/common';
import { LogisticsShipmentsService } from './logistics-shipments.service';
import { LogisticsShipmentsController } from './logistics-shipments.controller';
import { LogisticsErpShipmentsModule } from '../logistics-erp-shipments/logistics-erp-shipments.module';

// Hook close → orders.fulfilled (consume stock + history + alerts, J.6.1 fix).
// La dependencia hacia commercial está invertida vía ORDER_FULFILLMENT_PORT
// (token global bindeado en el composition root). Logística NO importa commercial.
//
// EMB.12 — importa el módulo del ERP sólo para LEER el viaje de Kepler que se toma
// (`createFromKepler`). La dirección es ésta y no al revés: el de Kepler sigue siendo de lectura.
@Module({
  imports: [LogisticsErpShipmentsModule],
  controllers: [LogisticsShipmentsController],
  providers: [LogisticsShipmentsService],
  exports: [LogisticsShipmentsService],
})
export class LogisticsShipmentsModule {}
