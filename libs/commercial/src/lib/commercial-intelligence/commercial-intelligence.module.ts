import { Module } from '@nestjs/common';
import { CommercialRecommendationsModule } from '../commercial-recommendations/commercial-recommendations.module';
import { Customer360Service } from './customer-360.service';
import { Customer360RefreshService } from './customer-360-refresh.service';
import { DecisionEngineService } from './decision-engine.service';
import { CommerceAgentService } from './commerce-agent.service';
import { FeedbackService } from './feedback.service';
import { CommercialIntelligenceController } from './commercial-intelligence.controller';

/**
 * Motor de Inteligencia Comercial (Fase M) — rebanada vertical V1.
 *
 * Capa 0 (Customer360Service = feature store) + Capa 1 (DecisionEngineService = NBA).
 * Determinista; el agente y los canales se suman en sprints posteriores (M.2+).
 * Importa CommercialRecommendationsModule para reusar la canasta `base` como
 * canasta de reorden sugerida.
 */
@Module({
  imports: [CommercialRecommendationsModule],
  controllers: [CommercialIntelligenceController],
  providers: [
    Customer360Service,
    Customer360RefreshService,
    DecisionEngineService,
    CommerceAgentService,
    FeedbackService,
  ],
  exports: [
    Customer360Service,
    DecisionEngineService,
    CommerceAgentService,
    FeedbackService,
  ],
})
export class CommercialIntelligenceModule {}
