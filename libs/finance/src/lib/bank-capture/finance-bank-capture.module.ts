import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { BankCaptureService } from './bank-capture.service';
import { BankCaptureController } from './bank-capture.controller';
import { BancosRealtimeModule } from '../bank/bancos-realtime.module';

/**
 * Fase CBW (ADR-042) — Captura bancaria por WhatsApp. Reusa `CloudinaryModule`
 * (adjunto img/PDF) y `AiProductMatcherModule` (que exporta `LlmExtractorService`
 * para el OCR de la ficha). El binding al puerto BANK_CAPTURE_PORT (que consume la
 * ingesta de WhatsApp) se hace en el composition root. NO escribe a bank_movements.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule, BancosRealtimeModule],
  controllers: [BankCaptureController],
  providers: [BankCaptureService],
  exports: [BankCaptureService],
})
export class FinanceBankCaptureModule {}
