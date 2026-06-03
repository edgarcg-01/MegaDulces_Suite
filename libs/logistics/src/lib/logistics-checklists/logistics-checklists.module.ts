import { Module } from '@nestjs/common';
import { LogisticsChecklistsService } from './logistics-checklists.service';
import { LogisticsChecklistsController } from './logistics-checklists.controller';

@Module({
  controllers: [LogisticsChecklistsController],
  providers: [LogisticsChecklistsService],
  exports: [LogisticsChecklistsService],
})
export class LogisticsChecklistsModule {}
