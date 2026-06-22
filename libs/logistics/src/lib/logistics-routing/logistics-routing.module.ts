import { Module } from '@nestjs/common';
import { LogisticsRoutingService } from './logistics-routing.service';
import { LogisticsRoutingController } from './logistics-routing.controller';

@Module({
  controllers: [LogisticsRoutingController],
  providers: [LogisticsRoutingService],
  exports: [LogisticsRoutingService],
})
export class LogisticsRoutingModule {}
