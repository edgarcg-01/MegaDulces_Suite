import { Module } from '@nestjs/common';
import { PickingController } from './picking.controller';
import { PickingService } from './picking.service';

/**
 * Fase SU.2 — pool de pedidos por surtir y olas de surtido (ADR-067).
 * TenantKnexService/TenantContextService son globales.
 */
@Module({
  controllers: [PickingController],
  providers: [PickingService],
  exports: [PickingService],
})
export class CommercialPickingModule {}
