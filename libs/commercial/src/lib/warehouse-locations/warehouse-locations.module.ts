import { Module } from '@nestjs/common';
import { WarehouseLocationsController } from './warehouse-locations.controller';
import { WarehouseLocationsService } from './warehouse-locations.service';
import { WarehouseLocationsBulkService } from './warehouse-locations-bulk.service';
import { WarehouseLocationsAssignService } from './warehouse-locations-assign.service';

/**
 * `[UB.1]` Ubicaciones de mercancía (Fase UB, ADR-090).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  controllers: [WarehouseLocationsController],
  providers: [WarehouseLocationsService, WarehouseLocationsBulkService, WarehouseLocationsAssignService],
  exports: [WarehouseLocationsService, WarehouseLocationsBulkService, WarehouseLocationsAssignService],
})
export class WarehouseLocationsModule {}
