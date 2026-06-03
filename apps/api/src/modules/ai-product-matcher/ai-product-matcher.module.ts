import { Module } from '@nestjs/common';
import { AiProductMatcherController } from './ai-product-matcher.controller';
import { AiProductMatcherService } from './ai-product-matcher.service';
import { EmbeddingSyncService } from './embedding-sync.service';
import { EmbeddingsService } from '@megadulces/platform-core';
import { LlmExtractorService } from '@megadulces/platform-core';

/**
 * Fase K — AI product match en captures.
 *
 * Expone:
 *   - `POST /api/ai/products/match-ai` — pipeline Haiku → Voyage → pgvector KNN.
 *   - `POST /api/ai/products/sync-now`  — fuerza tick del scanner.
 *
 * `EmbeddingSyncService` corre un @Cron cada 15min para detectar embeddings
 * stale (insert sin hook, rename de brand/producto) y refrescarlos.
 *
 * `EmbeddingsService` también se exporta para que `PlanogramsModule` lo
 * inyecte en el hook de re-embed síncrono al crear/actualizar productos.
 */
@Module({
  controllers: [AiProductMatcherController],
  providers: [
    AiProductMatcherService,
    EmbeddingsService,
    LlmExtractorService,
    EmbeddingSyncService,
  ],
  exports: [EmbeddingsService, AiProductMatcherService, LlmExtractorService],
})
export class AiProductMatcherModule {}
