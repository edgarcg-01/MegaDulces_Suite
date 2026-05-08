import { Module } from '@nestjs/common';
import { PlanogramsController, PlanogramsProductsController } from './planograms.controller';
import { PlanogramsService } from './planograms.service';

@Module({
  controllers: [PlanogramsController, PlanogramsProductsController],
  providers: [PlanogramsService],
  exports: [PlanogramsService],
})
export class PlanogramsModule {}
