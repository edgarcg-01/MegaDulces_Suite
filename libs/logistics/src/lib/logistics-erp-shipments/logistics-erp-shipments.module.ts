import { Module } from '@nestjs/common';
import { ErpShipmentsService } from './erp-shipments.service';
import { ErpShipmentsController } from './erp-shipments.controller';

/**
 * EMB — Embarques reales del ERP Kepler (sólo lectura sobre las vistas analytics.erp_shipment_*).
 * Vive aparte de LogisticsShipmentsModule a propósito: ese maneja el ciclo de vida de un
 * embarque PROPIO de la app (estados, guías, gastos, checklists); éste sólo expone lo que el
 * ERP ya decidió. Mezclarlos haría que un GET de lectura arrastre toda la maquinaria de escritura.
 */
@Module({
  controllers: [ErpShipmentsController],
  providers: [ErpShipmentsService],
  exports: [ErpShipmentsService],
})
export class LogisticsErpShipmentsModule {}
