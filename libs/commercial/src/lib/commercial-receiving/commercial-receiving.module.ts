import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { CommercialInventoryModule } from '../commercial-inventory/commercial-inventory.module';
import { ReceivingAuditorService } from './receiving-auditor.service';
import { ReceivingAuditorController } from './receiving-auditor.controller';

/**
 * Fase WMS-REC (Pieza 2 — Auditor de recepción por caducidad, ADR-044).
 *
 * Reusa `CloudinaryModule` (ObjectStorageService para la foto de evidencia),
 * `AiProductMatcherModule` (LlmExtractorService para el OCR de lote/caducidad) y
 * `CommercialInventoryModule` (CommercialInventoryService para escribir el 'in'
 * de stock que alimenta stock_lots/FEFO al aceptar la recepción).
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule, CommercialInventoryModule],
  controllers: [ReceivingAuditorController],
  providers: [ReceivingAuditorService],
  exports: [ReceivingAuditorService],
})
export class CommercialReceivingModule {}
