import { Module } from '@nestjs/common';
import { AnthropicService, CloudinaryModule } from '@megadulces/platform-core';
import { LevantamientoController } from './levantamiento.controller';
import { LevantamientoService } from './levantamiento.service';
import { RevisionController } from './revision.controller';
import { RevisionService } from './revision.service';
import { LectorFotoService } from './ia/lector-foto.service';
import { LectorFotosWorker } from './ia/lector-worker.service';

// [NP.7] Catálogo digital: fichas de producto (levantamiento desde el celular; después, altas desde fotos).
// CloudinaryModule provee ObjectStorageService (el bucket de las fotos).
// [NP.7.L.11d] El lector de fotos (IA) y su worker con topes. APAGADO salvo `NP7_AI_ENABLED=true` (D6);
// su `@Cron` necesita el `ScheduleModule.forRoot()` de `app.module.ts` (sin él, con DISABLE_CRONS, no corre).
// AnthropicService es infra hoja: cada módulo que lo usa lo pone en sus providers.
@Module({
  imports: [CloudinaryModule],
  controllers: [LevantamientoController, RevisionController],
  providers: [LevantamientoService, RevisionService, AnthropicService, LectorFotoService, LectorFotosWorker],
  exports: [LevantamientoService],
})
export class ProductSheetsModule {}
