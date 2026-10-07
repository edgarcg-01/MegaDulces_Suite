import { Module } from '@nestjs/common';
import { DailyCapturesController } from './daily-captures.controller';
import { DailyCapturesService } from './daily-captures.service';
import { CloudinaryModule } from '@megadulces/platform-core';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [CloudinaryModule, WebSocketModule],
  controllers: [DailyCapturesController],
  providers: [DailyCapturesService],
})
export class DailyCapturesModule {}
