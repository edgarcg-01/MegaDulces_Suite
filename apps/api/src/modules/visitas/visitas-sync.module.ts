import { Module } from '@nestjs/common';
import {
  VisitasSyncController,
  VisitasSyncLegacyController,
} from './visitas-sync.controller';
import { VisitasSyncService } from './visitas-sync.service';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [WebSocketModule],
  // VisitasSyncController = `/visits-sync/*` (canonical EN).
  // VisitasSyncLegacyController = `/visitas/*` deprecated aliases.
  // Para borrar los aliases en una release futura: quitar
  // VisitasSyncLegacyController de aquí y dejar solo el canonical.
  controllers: [VisitasSyncController, VisitasSyncLegacyController],
  providers: [VisitasSyncService, VisitasSyncController],
  exports: [VisitasSyncService],
})
export class VisitasSyncModule {}
