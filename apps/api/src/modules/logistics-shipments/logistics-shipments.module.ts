import { Module } from '@nestjs/common';
import { LogisticsShipmentsService } from './logistics-shipments.service';
import { LogisticsShipmentsController } from './logistics-shipments.controller';
// Hook close → commercial.orders.fulfilled requiere CommercialOrdersService
// para consumir stock + history + alerts (J.6.1 fix — antes hacíamos UPDATE
// pelado sin consumir stock).
import { CommercialOrdersModule } from '../commercial-orders/commercial-orders.module';

@Module({
  imports: [CommercialOrdersModule],
  controllers: [LogisticsShipmentsController],
  providers: [LogisticsShipmentsService],
  exports: [LogisticsShipmentsService],
})
export class LogisticsShipmentsModule {}
