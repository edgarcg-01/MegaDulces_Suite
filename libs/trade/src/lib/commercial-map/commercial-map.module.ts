import { Module } from '@nestjs/common';
import { CommercialMapController } from './commercial-map.controller';
import { CommercialMapService } from './commercial-map.service';

/**
 * Mapa Comercial (Trade Marketing). Read-only sobre `daily_captures`/`stores`
 * (connection legacy, mismo que ReportsModule). No requiere providers extra: el
 * KNEX_CONNECTION y TenantContextService vienen de módulos globales.
 */
@Module({
  controllers: [CommercialMapController],
  providers: [CommercialMapService],
})
export class CommercialMapModule {}
