import { Module } from '@nestjs/common';
import { DailyCapturesController } from './daily-captures.controller';
import { DailyCapturesService } from './daily-captures.service';
@Module({
  controllers: [DailyCapturesController],
  providers: [DailyCapturesService],
})
export class DailyCapturesModule {}
