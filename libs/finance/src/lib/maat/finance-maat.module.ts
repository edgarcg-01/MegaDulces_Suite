import { Module } from '@nestjs/common';
import { MaatKnowledgeService } from './maat-knowledge.service';
import { MaatKnowledgeController } from './maat-knowledge.controller';
import { MaatToolsService } from './maat-tools.service';
import { MaatChatService } from './maat-chat.service';
import { MaatBriefingService } from './maat-briefing.service';
import { MaatChatController } from './maat-chat.controller';
import { MaatDetectorService } from './maat-detector.service';
import { MaatFindingsService } from './maat-findings.service';
import { MaatScannerService } from './maat-scanner.service';
import { MaatFindingsController } from './maat-findings.controller';

/**
 * MAAT (ADR-028) — AI de Finanzas.
 *   MAAT.0 = base de conocimiento · MAAT.3 = chat tool-use ·
 *   MAAT.2 = motor de patrones (detectores) + bandeja de hallazgos + cron.
 * Próximos: baselines cron (MAAT.4).
 */
@Module({
  controllers: [MaatKnowledgeController, MaatChatController, MaatFindingsController],
  providers: [
    MaatKnowledgeService, MaatToolsService, MaatChatService, MaatBriefingService,
    MaatDetectorService, MaatFindingsService, MaatScannerService,
  ],
  exports: [MaatKnowledgeService, MaatChatService, MaatDetectorService],
})
export class FinanceMaatModule {}
