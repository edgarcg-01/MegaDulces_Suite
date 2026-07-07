import { Module } from '@nestjs/common';
import { MaatKnowledgeService } from './maat-knowledge.service';
import { MaatKnowledgeController } from './maat-knowledge.controller';
import { MaatToolsService } from './maat-tools.service';
import { MaatChatService } from './maat-chat.service';
import { MaatChatController } from './maat-chat.controller';

/**
 * MAAT (ADR-028) — AI de Finanzas. MAAT.0 = base de conocimiento.
 * MAAT.3 = chat "Pregúntale a Maat" (tool-use, patrón Thot Chat).
 * Próximos sprints suman aquí: findings/bandeja (MAAT.2), baselines cron (MAAT.4).
 */
@Module({
  controllers: [MaatKnowledgeController, MaatChatController],
  providers: [MaatKnowledgeService, MaatToolsService, MaatChatService],
  exports: [MaatKnowledgeService, MaatChatService],
})
export class FinanceMaatModule {}
