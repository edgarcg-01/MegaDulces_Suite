import { Module } from '@nestjs/common';
import { CommercialReplenishmentService } from './commercial-replenishment.service';
import { CommercialReplenishmentController } from './commercial-replenishment.controller';
import { ReplenishmentScannerService } from './replenishment-scanner.service';
import { CommercialPurchaseOrdersService } from './commercial-purchase-orders.service';
import { CommercialPurchaseOrdersController } from './commercial-purchase-orders.controller';
import { ReplenishmentExportService } from './replenishment-export.service';

/**
 * Proyecto Compras / Reabastecimiento (Fase RA — ADR-030).
 * Existencia crítica + sugerido de compra (RA.4) + requisiciones HITL (RA.7) +
 * OC en tránsito (RA.5) + scanner nocturno de hallazgos (RA.8) +
 * cadena de compra OC→OE que mueve stock (RA.15/ADR-031).
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 */
@Module({
  controllers: [CommercialReplenishmentController, CommercialPurchaseOrdersController],
  providers: [CommercialReplenishmentService, ReplenishmentScannerService, CommercialPurchaseOrdersService, ReplenishmentExportService],
  exports: [CommercialReplenishmentService, CommercialPurchaseOrdersService],
})
export class CommercialReplenishmentModule {}
