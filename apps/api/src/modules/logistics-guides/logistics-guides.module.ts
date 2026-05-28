import { Module } from '@nestjs/common';
import { LogisticsGuidesService } from './logistics-guides.service';
import { LogisticsGuidesController } from './logistics-guides.controller';

@Module({
  controllers: [LogisticsGuidesController],
  providers: [LogisticsGuidesService],
  exports: [LogisticsGuidesService],
})
export class LogisticsGuidesModule {}
