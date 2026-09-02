import { Module } from '@nestjs/common';
import { KpController } from './kp.controller';
import { KpService } from './kp.service';
import { KpExcelService } from './kp-excel.service';

@Module({
  controllers: [KpController],
  providers: [KpService, KpExcelService],
})
export class KpModule {}
