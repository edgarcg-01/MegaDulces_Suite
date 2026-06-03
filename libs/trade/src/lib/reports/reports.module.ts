import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PdfService } from './pdf.service';
import { WebSocketModule } from '../websocket/websocket.module';
import { ReportsCacheService } from './reports-cache.service';
import { BrandPresenceReportService } from './brand-presence-report.service';

@Module({
  imports: [WebSocketModule],
  controllers: [ReportsController],
  providers: [ReportsService, PdfService, ReportsCacheService, BrandPresenceReportService],
  exports: [ReportsCacheService],
})
export class ReportsModule {}
