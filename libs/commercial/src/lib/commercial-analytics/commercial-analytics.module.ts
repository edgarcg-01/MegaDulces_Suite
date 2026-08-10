import { Module } from '@nestjs/common';
import { AnthropicService } from '@megadulces/platform-core';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { CommercialAnalyticsController } from './commercial-analytics.controller';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { SellOutExportService } from './sell-out-export.service';
import { WeeklyAnalyticsService } from './weekly-analytics.service';
import { RoutePromoService } from './route-promo.service';
import { StoreAnalyticsController } from './store-analytics.controller';
import { WincajaController } from './wincaja.controller';
import { WincajaService } from './wincaja.service';

@Module({
  controllers: [CommercialAnalyticsController, StoreAnalyticsController, WincajaController],
  providers: [CommercialAnalyticsService, AnalyticsRefreshService, SellOutExportService, WeeklyAnalyticsService, RoutePromoService, AnthropicService, WincajaService],
  exports: [CommercialAnalyticsService, AnalyticsRefreshService],
})
export class CommercialAnalyticsModule {}
