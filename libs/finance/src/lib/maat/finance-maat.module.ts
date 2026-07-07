import { Module } from '@nestjs/common';
import { MaatKnowledgeService } from './maat-knowledge.service';
import { MaatKnowledgeController } from './maat-knowledge.controller';

/**
 * MAAT (ADR-028) — AI de Finanzas. MAAT.0 = base de conocimiento.
 * Próximos sprints suman aquí: findings/bandeja (MAAT.2), chat (MAAT.3),
 * baselines cron (MAAT.4).
 */
@Module({
  controllers: [MaatKnowledgeController],
  providers: [MaatKnowledgeService],
  exports: [MaatKnowledgeService],
})
export class FinanceMaatModule {}
