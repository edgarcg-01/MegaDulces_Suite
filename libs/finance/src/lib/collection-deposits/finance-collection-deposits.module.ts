import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { CollectionDepositsService } from './collection-deposits.service';
import { CollectionDepositsController } from './collection-deposits.controller';

/**
 * Fase CC — Comprobantes de Cobranza. Adjunta el comprobante de depósito (imagen/PDF)
 * + OCR a un cobro de Kepler (UA0501). Reusa `CloudinaryModule` (adjunto img/PDF) y
 * `AiProductMatcherModule` (que exporta `LlmExtractorService` para el OCR). Lee los
 * cobros del espejo read-only `analytics.erp_collections`; NO escribe a Kepler.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule],
  controllers: [CollectionDepositsController],
  providers: [CollectionDepositsService],
  exports: [CollectionDepositsService],
})
export class FinanceCollectionDepositsModule {}
