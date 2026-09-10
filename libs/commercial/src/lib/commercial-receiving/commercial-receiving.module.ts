import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { CommercialInventoryModule } from '../commercial-inventory/commercial-inventory.module';
import { ReceivingAuditorService } from './receiving-auditor.service';
import { ReceivingAuditorController } from './receiving-auditor.controller';
import { ReceivingSessionService } from './receiving-session.service';
import { ReceivingSessionController } from './receiving-session.controller';
import { ReceivingClaimsService } from './receiving-claims.service';
import { ReceivingClaimsController } from './receiving-claims.controller';

/**
 * Fase WMS-REC (Pieza 2 — Auditor de recepción por caducidad, ADR-044).
 *
 * Reusa `CloudinaryModule` (ObjectStorageService para la foto de evidencia),
 * `AiProductMatcherModule` (LlmExtractorService para el OCR de lote/caducidad) y
 * `CommercialInventoryModule` (CommercialInventoryService para escribir el 'in'
 * de stock que alimenta stock_lots/FEFO al aceptar la recepción).
 *
 * WMS-REC.8 suma `ReceivingClaimsService` (ADR-053): el reclamo del faltante, que el
 * cierre del vale levanta en su misma transacción.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule, CommercialInventoryModule],
  controllers: [ReceivingAuditorController, ReceivingSessionController, ReceivingClaimsController],
  providers: [ReceivingAuditorService, ReceivingSessionService, ReceivingClaimsService],
  exports: [ReceivingAuditorService, ReceivingSessionService, ReceivingClaimsService],
})
export class CommercialReceivingModule {}
