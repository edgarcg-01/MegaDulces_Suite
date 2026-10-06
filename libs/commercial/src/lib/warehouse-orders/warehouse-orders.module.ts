import { Module } from '@nestjs/common';
import { WarehouseOrdersController } from './warehouse-orders.controller';
import { WarehouseOrdersService } from './warehouse-orders.service';

/**
 * `[GP.1]` Tablero de pedidos del almacén (Fase GP, ADR-084).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  controllers: [WarehouseOrdersController],
  providers: [WarehouseOrdersService],
  exports: [WarehouseOrdersService],
})
export class WarehouseOrdersModule {}
