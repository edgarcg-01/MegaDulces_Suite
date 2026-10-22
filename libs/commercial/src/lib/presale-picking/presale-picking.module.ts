import { Module } from '@nestjs/common';
import { CommercialOrdersModule } from '../commercial-orders/commercial-orders.module';
import { PresaleControlModule } from '../presale-control/presale-control.module';
import { CommercialAlertsModule } from '../commercial-alerts/commercial-alerts.module';
import { CommercialPushModule } from '../commercial-push/commercial-push.module';
import { PresalePickingController, PresaleSellerStatusController, SellerRouteDayController } from './presale-picking.controller';
import { PresalePickingService } from './presale-picking.service';
import { PresaleRouteService } from './presale-route.service';

/**
 * `[MCP.3]` + `[MCP.8]` Surtido de preventa por pedido y avance para la vendedora.
 * `[MCP.3.6]` + la ruta del vendedor surtida como un pedido global (`PresaleRouteService`).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  imports: [CommercialOrdersModule, PresaleControlModule, CommercialAlertsModule, CommercialPushModule],
  controllers: [PresalePickingController, PresaleSellerStatusController, SellerRouteDayController],
  providers: [PresalePickingService, PresaleRouteService],
  exports: [PresalePickingService],
})
export class PresalePickingModule {}
