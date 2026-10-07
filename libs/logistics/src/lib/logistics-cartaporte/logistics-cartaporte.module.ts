import { Module } from '@nestjs/common';
import { LogisticsCartaporteService } from './logistics-cartaporte.service';
import { LogisticsCartaporteController } from './logistics-cartaporte.controller';
import { PacService } from './pac.service';

@Module({
  controllers: [LogisticsCartaporteController],
  providers: [LogisticsCartaporteService, PacService],
  exports: [LogisticsCartaporteService],
})
export class LogisticsCartaporteModule {}
