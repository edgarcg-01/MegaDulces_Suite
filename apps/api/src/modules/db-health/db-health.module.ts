import { Module } from '@nestjs/common';
import { CommercialAlertsModule } from '@megadulces/commercial';
import { DbHealthController } from './db-health.controller';
import { DbHealthService } from './db-health.service';
import { DbHealthScannerService } from './db-health-scanner.service';

/**
 * Módulo de salud de DB (Administración). Depende de KNEX_NEW_DB_ADMIN + TenantContextService
 * (provistos por módulos @Global bajo ENABLE_MULTITENANT) y de AlertsService (WS realtime,
 * de CommercialAlertsModule) para el scanner que abre/resuelve alertas persistidas.
 */
@Module({
  imports: [CommercialAlertsModule],
  controllers: [DbHealthController],
  providers: [DbHealthService, DbHealthScannerService],
})
export class DbHealthModule {}
