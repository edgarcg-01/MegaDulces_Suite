import { Module } from '@nestjs/common';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { CommercialAnalyticsController } from './commercial-analytics.controller';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { SellOutExportService } from './sell-out-export.service';

@Module({
  controllers: [CommercialAnalyticsController],
  providers: [CommercialAnalyticsService, AnalyticsRefreshService, SellOutExportService],
  exports: [CommercialAnalyticsService, AnalyticsRefreshService],
})
export class CommercialAnalyticsModule {}
