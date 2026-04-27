import { Module } from '@nestjs/common';
import { PlanogramsController } from './planograms.controller';
import { PlanogramsService } from './planograms.service';

@Module({
  controllers: [PlanogramsController],
  providers: [PlanogramsService],
  exports: [PlanogramsService],
})
export class PlanogramsModule {}
