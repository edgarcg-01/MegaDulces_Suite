import { Module } from '@nestjs/common';
import { CommercialCustomersModule } from '../commercial-customers/commercial-customers.module';
import { CommercialOrdersModule } from '../commercial-orders/commercial-orders.module';
import { CommercialPaymentsModule } from '../commercial-payments/commercial-payments.module';
import { CommercialHomeDeliveryController } from './commercial-home-delivery.controller';
import { CommercialHomeDeliveryService } from './commercial-home-delivery.service';
import { HomeDispatchService } from './home-dispatch.service';

/**
 * Fase LM.2/LM.4/LM.3/LM-K — intake + despacho + entrega de pedidos a domicilio.
 * DESPACHO vive AQUÍ (no en logística): es fulfillment comercial disparado por
 * tienda. Orquesta customers/orders/payments + HomeDispatchService (guías/paradas
 * logistics.* vía SQL, desde intake propio o folio Kepler). TenantKnexService global.
 */
@Module({
  imports: [CommercialCustomersModule, CommercialOrdersModule, CommercialPaymentsModule],
  controllers: [CommercialHomeDeliveryController],
  providers: [CommercialHomeDeliveryService, HomeDispatchService],
  exports: [CommercialHomeDeliveryService, HomeDispatchService],
})
export class CommercialHomeDeliveryModule {}
