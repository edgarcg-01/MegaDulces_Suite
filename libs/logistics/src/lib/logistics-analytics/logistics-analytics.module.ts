import { Module } from '@nestjs/common';
import { LogisticsAnalyticsService } from './logistics-analytics.service';
import { LogisticsAnalyticsController } from './logistics-analytics.controller';

@Module({
  controllers: [LogisticsAnalyticsController],
  providers: [LogisticsAnalyticsService],
  exports: [LogisticsAnalyticsService],
})
export class LogisticsAnalyticsModule {}
