import { Module } from '@nestjs/common';
import { AnthropicService, PgListenService } from '@megadulces/platform-core';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { CommercialAnalyticsController } from './commercial-analytics.controller';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { PeriodCloseCheckService } from './period-close-check.service';
import { SellOutExportService } from './sell-out-export.service';
import { WeeklyAnalyticsService } from './weekly-analytics.service';
import { RoutePromoService } from './route-promo.service';
import { StoreAnalyticsController } from './store-analytics.controller';
import { WincajaController } from './wincaja.controller';
import { WincajaService } from './wincaja.service';
import { SelloutChatService } from './sellout-chat.service';
import { SelloutChatToolsService } from './sellout-chat-tools.service';
import { ExistenciaPorEventoService } from './existencia-por-evento.service';

/**
 * `[CANON.6.21]` `ExistenciaPorEventoService` escucha `existencia_sucia`: `PgListenService` NO es global, cada
 * dominio que escucha lo provee (como CommercialSalesDocumentsModule). La conexión LISTEN se abre sólo si alguien
 * escucha — y el que drena sólo escucha en el worker.
 */
@Module({
  controllers: [CommercialAnalyticsController, StoreAnalyticsController, WincajaController],
  providers: [CommercialAnalyticsService, AnalyticsRefreshService, PeriodCloseCheckService, SellOutExportService, WeeklyAnalyticsService, RoutePromoService, AnthropicService, WincajaService, SelloutChatService, SelloutChatToolsService,
    PgListenService, ExistenciaPorEventoService],
  exports: [CommercialAnalyticsService, AnalyticsRefreshService, PeriodCloseCheckService],
})
export class CommercialAnalyticsModule {}
