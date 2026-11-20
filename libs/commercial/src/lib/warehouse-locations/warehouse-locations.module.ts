import { Module } from '@nestjs/common';
import { WarehouseLocationsController } from './warehouse-locations.controller';
import { WarehouseLocationsService } from './warehouse-locations.service';
import { WarehouseLocationsBulkService } from './warehouse-locations-bulk.service';
import { WarehouseLocationsAssignService } from './warehouse-locations-assign.service';
import { WarehouseCartsController } from './warehouse-carts.controller';
import { WarehouseCartsService } from './warehouse-carts.service';

/**
 * `[UB.1]` Ubicaciones de mercancía (Fase UB, ADR-090).
 * `[GP.11.4]` + carretas y carritos: el mismo catálogo, familia `carreta` (FASE_UB D8).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  controllers: [WarehouseLocationsController, WarehouseCartsController],
  providers: [WarehouseLocationsService, WarehouseLocationsBulkService, WarehouseLocationsAssignService, WarehouseCartsService],
  exports: [WarehouseLocationsService, WarehouseLocationsBulkService, WarehouseLocationsAssignService],
})
export class WarehouseLocationsModule {}
