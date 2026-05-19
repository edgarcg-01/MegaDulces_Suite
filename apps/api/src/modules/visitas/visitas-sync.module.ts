import { Module } from '@nestjs/common';
import { VisitasSyncController } from './visitas-sync.controller';
import { VisitasSyncService } from './visitas-sync.service';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [WebSocketModule],
  controllers: [VisitasSyncController],
  providers: [VisitasSyncService],
  exports: [VisitasSyncService]
})
export class VisitasSyncModule {}
