import { Module } from '@nestjs/common';
import { LogisticsFleetService } from './logistics-fleet.service';
import { LogisticsFleetController } from './logistics-fleet.controller';

@Module({
  controllers: [LogisticsFleetController],
  providers: [LogisticsFleetService],
  exports: [LogisticsFleetService],
})
export class LogisticsFleetModule {}
