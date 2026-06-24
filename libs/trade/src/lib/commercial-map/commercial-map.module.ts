import { Module } from '@nestjs/common';
import { CommercialMapController } from './commercial-map.controller';
import { CommercialMapService } from './commercial-map.service';
import { ProspectsController } from './prospects.controller';
import { ProspectsService } from './prospects.service';
import { ProspectsRefreshService } from './prospects-refresh.service';
import { DenueClientService } from './denue-client.service';

/**
 * Mapa Comercial (Trade Marketing). Read-only sobre `daily_captures`/`stores`
 * (connection legacy, mismo que ReportsModule). Incluye la prospección DENUE
 * (Fase DENUE): cosecha + dedup + capa de oportunidad. El @Cron de
 * ProspectsRefreshService usa ScheduleModule.forRoot() (global en app.module).
 * No requiere providers extra: KNEX_CONNECTION y TenantContextService son globales.
 */
@Module({
  controllers: [CommercialMapController, ProspectsController],
  providers: [CommercialMapService, ProspectsService, ProspectsRefreshService, DenueClientService],
})
export class CommercialMapModule {}
