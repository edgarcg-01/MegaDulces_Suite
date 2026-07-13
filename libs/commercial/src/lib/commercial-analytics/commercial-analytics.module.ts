import { Module } from '@nestjs/common';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { CommercialAnalyticsController } from './commercial-analytics.controller';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { SellOutExportService } from './sell-out-export.service';
import { WeeklyAnalyticsService } from './weekly-analytics.service';
import { StoreAnalyticsController } from './store-analytics.controller';

@Module({
  controllers: [CommercialAnalyticsController, StoreAnalyticsController],
  providers: [CommercialAnalyticsService, AnalyticsRefreshService, SellOutExportService, WeeklyAnalyticsService],
  exports: [CommercialAnalyticsService, AnalyticsRefreshService],
})
export class CommercialAnalyticsModule {}
