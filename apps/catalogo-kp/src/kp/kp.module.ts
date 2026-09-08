import { Module } from '@nestjs/common';
import { KpController } from './kp.controller';
import { KpService } from './kp.service';

@Module({
  controllers: [KpController],
  providers: [KpService],
})
export class KpModule {}
