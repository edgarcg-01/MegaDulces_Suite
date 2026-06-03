import { Module } from '@nestjs/common';
import { TicketExtractorController } from './ticket-extractor.controller';
import { TicketExtractorService } from './ticket-extractor.service';
import { CloudinaryModule } from '@megadulces/platform-core';
import { AiProductMatcherModule } from '@megadulces/platform-core';

/**
 * Fase V — Endpoint `POST /api/ai/ticket/extract`.
 *
 * Reusa `AiProductMatcherModule` para el matcher contra catálogo y
 * `LlmExtractorService` (vision) que ahí mismo se exporta.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule],
  controllers: [TicketExtractorController],
  providers: [TicketExtractorService],
})
export class TicketExtractorModule {}
