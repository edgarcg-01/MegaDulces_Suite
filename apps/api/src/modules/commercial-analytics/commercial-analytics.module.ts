import { Module } from '@nestjs/common';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { CommercialAnalyticsController } from './commercial-analytics.controller';
import { AnalyticsRefreshService } from './analytics-refresh.service';

@Module({
  controllers: [CommercialAnalyticsController],
  providers: [CommercialAnalyticsService, AnalyticsRefreshService],
  exports: [CommercialAnalyticsService, AnalyticsRefreshService],
})
export class CommercialAnalyticsModule {}
