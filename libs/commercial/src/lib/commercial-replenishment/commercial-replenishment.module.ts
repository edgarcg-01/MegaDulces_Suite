import { Module } from '@nestjs/common';
import { CommercialReplenishmentService } from './commercial-replenishment.service';
import { CommercialReplenishmentController } from './commercial-replenishment.controller';

/**
 * Proyecto Compras / Reabastecimiento (Fase RA — ADR-030).
 * Existencia crítica + sugerido de compra (RA.4) + requisiciones HITL (RA.7).
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 */
@Module({
  controllers: [CommercialReplenishmentController],
  providers: [CommercialReplenishmentService],
  exports: [CommercialReplenishmentService],
})
export class CommercialReplenishmentModule {}
