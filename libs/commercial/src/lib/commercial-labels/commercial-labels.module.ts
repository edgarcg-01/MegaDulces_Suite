import { Module } from '@nestjs/common';
import { CommercialLabelsService } from './commercial-labels.service';
import { CommercialLabelsController } from './commercial-labels.controller';
import { PriceChangeNoticesService } from './price-change-notices.service';

/**
 * Etiquetera (proyecto Tienda). Impresión de etiquetas de anaquel con precio escalonado.
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 */
@Module({
  controllers: [CommercialLabelsController],
  providers: [CommercialLabelsService, PriceChangeNoticesService],
  exports: [CommercialLabelsService, PriceChangeNoticesService],
})
export class CommercialLabelsModule {}
