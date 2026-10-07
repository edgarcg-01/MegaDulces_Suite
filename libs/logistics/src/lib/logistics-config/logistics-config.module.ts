import { Module } from '@nestjs/common';
import { LogisticsConfigService } from './logistics-config.service';
import { LogisticsConfigController } from './logistics-config.controller';

@Module({
  controllers: [LogisticsConfigController],
  providers: [LogisticsConfigService],
  exports: [LogisticsConfigService],
})
export class LogisticsConfigModule {}
