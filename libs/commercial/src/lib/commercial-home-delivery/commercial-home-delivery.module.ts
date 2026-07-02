import { Module } from '@nestjs/common';
import { CommercialCustomersModule } from '../commercial-customers/commercial-customers.module';
import { CommercialOrdersModule } from '../commercial-orders/commercial-orders.module';
import { CommercialPaymentsModule } from '../commercial-payments/commercial-payments.module';
import { CommercialHomeDeliveryController } from './commercial-home-delivery.controller';
import { CommercialHomeDeliveryService } from './commercial-home-delivery.service';

/**
 * Fase LM.2/LM.4 — intake + entrega de pedidos a domicilio. Orquesta
 * CommercialCustomersService (alta casual) + CommercialOrdersService
 * (draft → líneas → place / cancel) + CommercialPaymentsService (deliverAndCollect).
 */
@Module({
  imports: [CommercialCustomersModule, CommercialOrdersModule, CommercialPaymentsModule],
  controllers: [CommercialHomeDeliveryController],
  providers: [CommercialHomeDeliveryService],
  exports: [CommercialHomeDeliveryService],
})
export class CommercialHomeDeliveryModule {}
