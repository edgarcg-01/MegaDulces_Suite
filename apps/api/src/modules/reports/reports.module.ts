import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PdfService } from './pdf.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, PdfService],
})
export class ReportsModule {}
