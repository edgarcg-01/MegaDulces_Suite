import { Module } from '@nestjs/common';
import { CommercialOrdersModule } from '../commercial-orders/commercial-orders.module';
import { PresaleControlModule } from '../presale-control/presale-control.module';
import { CommercialAlertsModule } from '../commercial-alerts/commercial-alerts.module';
import { CommercialPushModule } from '../commercial-push/commercial-push.module';
import { PresalePickingController, PresaleSellerStatusController, SellerRouteDayController } from './presale-picking.controller';
import { PresalePickingService } from './presale-picking.service';
import { PresaleRouteService } from './presale-route.service';
import { PresaleReviewController } from './presale-review.controller';
import { PresaleReviewService } from './presale-review.service';
import { VecinalMonitorController } from './vecinal-monitor.controller';
import { VecinalMonitorService } from './vecinal-monitor.service';
import { CommercialVendorRoutesModule } from '../commercial-vendor-routes/commercial-vendor-routes.module';
import { SellerDayRecapController } from './recuento-dia.controller';
import { SellerDayRecapService } from './recuento-dia.service';

/**
 * `[MCP.3]` + `[MCP.8]` Surtido de preventa por pedido y avance para la vendedora.
 * `[MCP.3.6]` + la ruta del vendedor surtida como un pedido global (`PresaleRouteService`).
 * `[MCP.10]` + la revisión en caja de lo surtido (`PresaleReviewService`).
 * `[MV.1]` + el Monitoreo vecinal de surtidores y cajeras (`VecinalMonitorService`, sólo lectura).
 * `[MCP.19]` + el recuento del día del vendedor (`SellerDayRecapService`), que lee las visitas del
 * monitoreo de `CommercialVendorRoutesModule` (ese módulo no importa nada: no hay ciclo).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  imports: [CommercialOrdersModule, PresaleControlModule, CommercialAlertsModule, CommercialPushModule, CommercialVendorRoutesModule],
  controllers: [PresalePickingController, PresaleSellerStatusController, SellerRouteDayController, PresaleReviewController, VecinalMonitorController, SellerDayRecapController],
  providers: [PresalePickingService, PresaleRouteService, PresaleReviewService, VecinalMonitorService, SellerDayRecapService],
  exports: [PresalePickingService],
})
export class PresalePickingModule {}
