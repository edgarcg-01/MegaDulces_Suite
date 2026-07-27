import { Module } from '@nestjs/common';
import { CommercialPricingModule } from '../commercial-pricing/commercial-pricing.module';
import { OrderStockService } from '../commercial-orders/order-stock.service';
import { StockReservationService } from './stock-reservation.service';
import { StockReservationCronService } from './stock-reservation-cron.service';

/**
 * FIQ.6 (ADR-038) — Apartado de pedidos con TTL.
 *
 * OrderStockService se provee localmente (es stateless: solo depende de
 * TenantContextService @Global) para reservar/liberar stock con el guard
 * anti-congelamiento, sin acoplar todo CommercialOrdersModule. El cron se
 * registra aquí; ScheduleModule.forRoot() ya vive en AppModule.
 */
@Module({
  imports: [CommercialPricingModule],
  providers: [StockReservationService, StockReservationCronService, OrderStockService],
  exports: [StockReservationService],
})
export class CommercialStockReservationModule {}
