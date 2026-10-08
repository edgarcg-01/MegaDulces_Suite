import { Module } from '@nestjs/common';
import { WarehouseLocationsController } from './warehouse-locations.controller';
import { WarehouseLocationsService } from './warehouse-locations.service';

/**
 * `[UB.1]` Ubicaciones de mercancía (Fase UB, ADR-090).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  controllers: [WarehouseLocationsController],
  providers: [WarehouseLocationsService],
  exports: [WarehouseLocationsService],
})
export class WarehouseLocationsModule {}
