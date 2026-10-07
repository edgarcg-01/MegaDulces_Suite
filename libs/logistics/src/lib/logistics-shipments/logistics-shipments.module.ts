import { Module } from '@nestjs/common';
import { LogisticsShipmentsService } from './logistics-shipments.service';
import { LogisticsShipmentsController } from './logistics-shipments.controller';

// Hook close → orders.fulfilled (consume stock + history + alerts, J.6.1 fix).
// La dependencia hacia commercial está invertida vía ORDER_FULFILLMENT_PORT
// (token global bindeado en el composition root). Logística NO importa commercial.
@Module({
  controllers: [LogisticsShipmentsController],
  providers: [LogisticsShipmentsService],
  exports: [LogisticsShipmentsService],
})
export class LogisticsShipmentsModule {}
