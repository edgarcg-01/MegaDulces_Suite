import { Module } from '@nestjs/common';
import { CommercialOrdersModule } from '../commercial-orders/commercial-orders.module';
import { CommercialPaymentsController } from './commercial-payments.controller';
import { CommercialPaymentsService } from './commercial-payments.service';

/**
 * Fase LM.1 — cobros sobre pedidos (commercial.payments). Reusa
 * CommercialOrdersService (exportado por CommercialOrdersModule) para el
 * fulfill atómico de deliverAndCollect. TenantKnexService/TenantContextService
 * son globales.
 */
@Module({
  imports: [CommercialOrdersModule],
  controllers: [CommercialPaymentsController],
  providers: [CommercialPaymentsService],
  exports: [CommercialPaymentsService],
})
export class CommercialPaymentsModule {}
