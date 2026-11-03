import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { LevantamientoController } from './levantamiento.controller';
import { LevantamientoService } from './levantamiento.service';
import { RevisionController } from './revision.controller';
import { RevisionService } from './revision.service';

// [NP.7] Catálogo digital: fichas de producto (levantamiento desde el celular; después, altas desde fotos).
// CloudinaryModule provee ObjectStorageService (el bucket de las fotos).
@Module({
  imports: [CloudinaryModule],
  controllers: [LevantamientoController, RevisionController],
  providers: [LevantamientoService, RevisionService],
  exports: [LevantamientoService],
})
export class ProductSheetsModule {}
