import { Module } from '@nestjs/common';
import { EmbeddingsService } from '@megadulces/platform-core';
import { MaatKnowledgeService } from './maat-knowledge.service';
import { MaatKnowledgeVectorService } from './maat-knowledge-vector.service';
import { MaatProviderGraphService } from './maat-provider-graph.service';
import { MaatKnowledgeController } from './maat-knowledge.controller';
import { MaatToolsService } from './maat-tools.service';
import { MaatChatService } from './maat-chat.service';
import { MaatBriefingService } from './maat-briefing.service';
import { MaatChatController } from './maat-chat.controller';
import { MaatDetectorService } from './maat-detector.service';
import { MaatAnomalyService } from './maat-anomaly.service';
import { MaatFindingsService } from './maat-findings.service';
import { MaatScannerService } from './maat-scanner.service';
import { MaatFindingsController } from './maat-findings.controller';
import { MaatActionsService } from './maat-actions.service';
import { MaatActionsController } from './maat-actions.controller';
import { MaatFindingsSinkService } from './maat-findings-sink.service';
import { MaatLearningService } from './maat-learning.service';
import { MaatEvalService } from './maat-eval.service';
import { MaatLearningController } from './maat-learning.controller';

/**
 * MAAT (ADR-028) — AI de Finanzas.
 *   MAAT.0 = base de conocimiento · MAAT.3 = chat tool-use ·
 *   MAAT.2 = motor de patrones (detectores) + bandeja de hallazgos + cron.
 *   MAAT-IQ = detección estadística (MIQ.1) + modelo que aprende (MIQ.2) +
 *             backtest (MIQ.6). El motor detecta / el modelo prioriza aprendiendo
 *             del feedback / el LLM sigue fuera de los números.
 */
@Module({
  controllers: [MaatKnowledgeController, MaatChatController, MaatFindingsController, MaatActionsController, MaatLearningController],
  providers: [
    MaatKnowledgeService, MaatToolsService, MaatChatService, MaatBriefingService,
    MaatDetectorService, MaatAnomalyService, MaatFindingsService, MaatScannerService, MaatActionsService,
    EmbeddingsService, MaatKnowledgeVectorService, MaatProviderGraphService,
    MaatFindingsSinkService, MaatLearningService, MaatEvalService,
  ],
  exports: [MaatKnowledgeService, MaatChatService, MaatDetectorService, MaatKnowledgeVectorService, MaatProviderGraphService, MaatFindingsSinkService],
})
export class FinanceMaatModule {}
