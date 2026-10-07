import { Module } from '@nestjs/common';
import { CommercialOrdersService } from './commercial-orders.service';
import { OrderStockService } from './order-stock.service';
import { InvoiceRetryCronService } from './invoice-retry-cron.service';
import { CommercialOrdersController } from './commercial-orders.controller';
import { CommercialPricingModule } from '../commercial-pricing/commercial-pricing.module';
import { CommercialInventoryModule } from '../commercial-inventory/commercial-inventory.module';
import { CommercialAlertsModule } from '../commercial-alerts/commercial-alerts.module';
import { CommercialPushModule } from '../commercial-push/commercial-push.module';
// [VTK.2] El pedido se cobra con el motor de precios de cotizaciones (QuotePricingService).
import { CommercialQuotesModule } from '../commercial-quotes/commercial-quotes.module';

@Module({
  imports: [CommercialPricingModule, CommercialInventoryModule, CommercialAlertsModule, CommercialPushModule, CommercialQuotesModule],
  controllers: [CommercialOrdersController],
  providers: [CommercialOrdersService, OrderStockService, InvoiceRetryCronService],
  exports: [CommercialOrdersService],
})
export class CommercialOrdersModule {}
