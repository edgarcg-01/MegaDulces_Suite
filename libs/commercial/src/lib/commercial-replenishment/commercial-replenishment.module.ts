import { Module } from '@nestjs/common';
import { ObjectStorageService } from '@megadulces/platform-core';
import { CommercialReplenishmentService } from './commercial-replenishment.service';
import { AutoabastoController } from './autoabasto.controller';
import { AutoabastoPedidoService } from './autoabasto-pedido.service';
import { CommercialReplenishmentController } from './commercial-replenishment.controller';
import { ReplenishmentScannerService } from './replenishment-scanner.service';
import { CommercialPurchaseOrdersService } from './commercial-purchase-orders.service';
import { CommercialPurchaseOrdersController } from './commercial-purchase-orders.controller';
import { ReplenishmentExportService } from './replenishment-export.service';
import { PurchaseAdjustmentsService } from './purchase-adjustments.service';
import { PurchaseAdjustmentsController } from './purchase-adjustments.controller';
import { PurchaseAdjustmentsFindingsBridgeService } from './purchase-adjustments-findings-bridge.service';
import { PurchaseFlowService } from './purchase-flow.service';
import { PurchaseFlowController } from './purchase-flow.controller';
import { PedidoNegociacionService } from './pedido-negociacion.service';
import { PedidoNegociacionController } from './pedido-negociacion.controller';
import { KEPLER_REQUISITION_SINK_PORT } from '@megadulces/contracts';
import { KeplerRequisitionSinkAdapter } from './kepler-requisition-sink.adapter';

/**
 * Proyecto Compras / Reabastecimiento (Fase RA — ADR-030).
 * Existencia crítica + sugerido de compra (RA.4) + requisiciones HITL (RA.7) +
 * OC en tránsito (RA.5) + scanner nocturno de hallazgos (RA.8) +
 * cadena de compra OC→OE que mueve stock (RA.15/ADR-031).
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 */
@Module({
  controllers: [CommercialReplenishmentController, AutoabastoController, CommercialPurchaseOrdersController, PurchaseAdjustmentsController, PurchaseFlowController, PedidoNegociacionController],
  providers: [CommercialReplenishmentService, AutoabastoPedidoService, ReplenishmentScannerService, CommercialPurchaseOrdersService, ReplenishmentExportService, PurchaseAdjustmentsService, PurchaseAdjustmentsFindingsBridgeService, ObjectStorageService, PurchaseFlowService, PedidoNegociacionService,
    // `[KR.4]` La puerta hacia Kepler (ADR-016, excepción autorizada 2026-10-13).
    // ⛔ Estar ligado NO significa estar encendido: el adapter sólo abre conexión si existe
    // `KEPLER_PUSH_URL`, y aunque exista, sin `GRANT INSERT` sobre `md.kdm1`/`kdm2` la base
    // rechaza la escritura. Son tres candados independientes y el de la base es el que manda.
    KeplerRequisitionSinkAdapter,
    { provide: KEPLER_REQUISITION_SINK_PORT, useExisting: KeplerRequisitionSinkAdapter }],
  exports: [CommercialReplenishmentService, CommercialPurchaseOrdersService, PurchaseAdjustmentsService],
})
export class CommercialReplenishmentModule {}
