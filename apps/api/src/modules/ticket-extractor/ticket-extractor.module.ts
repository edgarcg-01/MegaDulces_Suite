import { Module } from '@nestjs/common';
import { TicketExtractorController } from './ticket-extractor.controller';
import { TicketExtractorService } from './ticket-extractor.service';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { AiProductMatcherModule } from '../ai-product-matcher/ai-product-matcher.module';

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
