import { Module } from '@nestjs/common';
import { LogisticsReportsService } from './logistics-reports.service';
import { LogisticsReportsController } from './logistics-reports.controller';

@Module({
  controllers: [LogisticsReportsController],
  providers: [LogisticsReportsService],
  exports: [LogisticsReportsService],
})
export class LogisticsReportsModule {}
