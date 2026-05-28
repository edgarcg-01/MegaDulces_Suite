import { Module } from '@nestjs/common';
import { CommercialOrdersService } from './commercial-orders.service';
import { CommercialOrdersController } from './commercial-orders.controller';
import { CommercialPricingModule } from '../commercial-pricing/commercial-pricing.module';
import { CommercialInventoryModule } from '../commercial-inventory/commercial-inventory.module';
import { CommercialAlertsModule } from '../commercial-alerts/commercial-alerts.module';

@Module({
  imports: [CommercialPricingModule, CommercialInventoryModule, CommercialAlertsModule],
  controllers: [CommercialOrdersController],
  providers: [CommercialOrdersService],
  exports: [CommercialOrdersService],
})
export class CommercialOrdersModule {}
