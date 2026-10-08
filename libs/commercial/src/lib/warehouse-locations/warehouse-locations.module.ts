import { Module } from '@nestjs/common';
import { WarehouseLocationsController } from './warehouse-locations.controller';
import { WarehouseLocationsService } from './warehouse-locations.service';
import { WarehouseLocationsBulkService } from './warehouse-locations-bulk.service';

/**
 * `[UB.1]` Ubicaciones de mercancía (Fase UB, ADR-090).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  controllers: [WarehouseLocationsController],
  providers: [WarehouseLocationsService, WarehouseLocationsBulkService],
  exports: [WarehouseLocationsService, WarehouseLocationsBulkService],
})
export class WarehouseLocationsModule {}
