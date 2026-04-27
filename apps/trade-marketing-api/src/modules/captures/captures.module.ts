import { Module } from '@nestjs/common';
import { CapturesController } from './captures.controller';
import { CapturesService } from './captures.service';

@Module({
  controllers: [CapturesController],
  providers: [CapturesService],
})
export class CapturesModule {}
