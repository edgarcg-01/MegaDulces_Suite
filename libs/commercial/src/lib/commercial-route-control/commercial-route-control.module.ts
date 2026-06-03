import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { CommercialRouteControlController } from './commercial-route-control.controller';
import { CommercialRouteControlService } from './commercial-route-control.service';

/**
 * "Cierre de ruta" — tickets diarios del vendedor (venta/carga/combustible).
 * Reusa CloudinaryModule (upload) y LlmExtractorService (vision, exportado por
 * AiProductMatcherModule). TenantKnexService/TenantContextService son globales.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule],
  controllers: [CommercialRouteControlController],
  providers: [CommercialRouteControlService],
})
export class CommercialRouteControlModule {}
