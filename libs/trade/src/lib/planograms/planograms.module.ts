import { Module } from '@nestjs/common';
import { PlanogramsController, PlanogramsProductsController } from './planograms.controller';
import { PlanogramsService } from './planograms.service';
import { AiProductMatcherModule } from '@megadulces/platform-core';

@Module({
  // Fase K: importa AiProductMatcherModule para inyectar EmbeddingsService
  // en el hook de re-embed (add/updateProduct). EmbeddingsService es exportado
  // desde ese módulo.
  imports: [AiProductMatcherModule],
  controllers: [PlanogramsController, PlanogramsProductsController],
  providers: [PlanogramsService],
  exports: [PlanogramsService],
})
export class PlanogramsModule {}
