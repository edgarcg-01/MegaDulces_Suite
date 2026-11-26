import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { jwtVerifyOptions, requireJwtSecret } from '@megadulces/platform-core';
import { CommercialOrdersService } from './commercial-orders.service';
import { OrderStockService } from './order-stock.service';
import { InvoiceRetryCronService } from './invoice-retry-cron.service';
// [DN.8] El barrido que declara `sin_dato` lo que el registro de lo negado no completó al agendar.
import { OrderStockNoticesCronService } from './order-stock-notices-cron.service';
import { CommercialOrdersController } from './commercial-orders.controller';
// [MCP.36] La liga del QR de la etiqueta del pedido: firmarla (quien imprime) y abrirla sin sesión (cualquiera).
import { PedidoEtiquetaController, PedidoPublicoController } from './pedido-etiqueta.controller';
import { PedidoEtiquetaService } from './pedido-etiqueta.service';
import { CommercialPricingModule } from '../commercial-pricing/commercial-pricing.module';
import { CommercialInventoryModule } from '../commercial-inventory/commercial-inventory.module';
import { CommercialAlertsModule } from '../commercial-alerts/commercial-alerts.module';
import { CommercialPushModule } from '../commercial-push/commercial-push.module';
// [VTK.2] El pedido se cobra con el motor de precios de cotizaciones (QuotePricingService).
import { CommercialQuotesModule } from '../commercial-quotes/commercial-quotes.module';

@Module({
  imports: [
    CommercialPricingModule, CommercialInventoryModule, CommercialAlertsModule, CommercialPushModule, CommercialQuotesModule,
    // [MCP.36] La liga de la etiqueta firma y verifica con su PROPIA clave (derivada en PedidoEtiquetaService).
    JwtModule.register({ secret: requireJwtSecret(), signOptions: { algorithm: 'HS256' }, verifyOptions: jwtVerifyOptions }),
  ],
  controllers: [CommercialOrdersController, PedidoEtiquetaController, PedidoPublicoController],
  providers: [CommercialOrdersService, OrderStockService, InvoiceRetryCronService, OrderStockNoticesCronService, PedidoEtiquetaService],
  exports: [CommercialOrdersService],
})
export class CommercialOrdersModule {}
