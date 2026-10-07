import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PdfService } from './pdf.service';
import { WebSocketModule } from '../websocket/websocket.module';
import { ReportsCacheService } from './reports-cache.service';
import { BrandPresenceReportService } from './brand-presence-report.service';
import { MapMatchingService } from './map-matching.service';
import { FieldAlertsScannerService } from './field-alerts-scanner.service';
import { MapboxService } from './mapbox.service';

@Module({
  imports: [WebSocketModule],
  controllers: [ReportsController],
  providers: [ReportsService, PdfService, ReportsCacheService, BrandPresenceReportService, MapMatchingService, FieldAlertsScannerService, MapboxService],
  exports: [ReportsCacheService],
})
export class ReportsModule {}
