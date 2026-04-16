import { Module } from '@nestjs/common';
import { VisitasSyncController } from './visitas-sync.controller';
import { VisitasSyncService } from './visitas-sync.service';

@Module({
  controllers: [VisitasSyncController],
  providers: [VisitasSyncService],
  exports: [VisitasSyncService]
})
export class VisitasSyncModule {}
