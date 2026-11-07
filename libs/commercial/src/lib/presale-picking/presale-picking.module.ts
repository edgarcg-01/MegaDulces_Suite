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

/**
 * `[MCP.3]` + `[MCP.8]` Surtido de preventa por pedido y avance para la vendedora.
 * `[MCP.3.6]` + la ruta del vendedor surtida como un pedido global (`PresaleRouteService`).
 * `[MCP.10]` + la revisión en caja de lo surtido (`PresaleReviewService`).
 * `[MV.1]` + el Monitoreo vecinal de surtidores y cajeras (`VecinalMonitorService`, sólo lectura).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  imports: [CommercialOrdersModule, PresaleControlModule, CommercialAlertsModule, CommercialPushModule],
  controllers: [PresalePickingController, PresaleSellerStatusController, SellerRouteDayController, PresaleReviewController, VecinalMonitorController],
  providers: [PresalePickingService, PresaleRouteService, PresaleReviewService, VecinalMonitorService],
  exports: [PresalePickingService],
})
export class PresalePickingModule {}
