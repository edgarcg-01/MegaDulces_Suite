import { Module } from '@nestjs/common';
import { CommercialRecommendationsModule } from '../commercial-recommendations/commercial-recommendations.module';
import { Customer360Service } from './customer-360.service';
import { Customer360RefreshService } from './customer-360-refresh.service';
import { DecisionEngineService } from './decision-engine.service';
import { CommerceAgentService } from './commerce-agent.service';
import { FeedbackService } from './feedback.service';
import { ThotService } from './thot.service';
import { PushDirectivesService } from './push-directives.service';
import { CommercialFindingsService } from './commercial-findings.service';
import { CommercialDiagnosisService } from './commercial-diagnosis.service';
import { CommercialActionsService } from './commercial-actions.service';
import { CommercialCalibrationService } from './commercial-calibration.service';
import { AutonomyService } from './autonomy.service';
import { CommercialAnalyticsService } from '../commercial-analytics/commercial-analytics.service';
import { ThotToolsService } from './thot-chat/thot-tools.service';
import { PortalThotToolsService } from './thot-chat/portal-thot-tools.service';
import { VendorThotToolsService } from './thot-chat/vendor-thot-tools.service';
import { ThotChatService } from './thot-chat/thot-chat.service';
import { ThotExamplesService } from './thot-chat/thot-examples.service';
import { ThotExampleVectorService } from './thot-chat/thot-example-vector.service';
import { EmbeddingsService } from '@megadulces/platform-core';
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
    ThotService,
    PushDirectivesService,
    CommercialFindingsService,
    CommercialDiagnosisService,
    CommercialActionsService,
    CommercialCalibrationService,
    AutonomyService,
    CommercialAnalyticsService,
    ThotToolsService,
    PortalThotToolsService,
    VendorThotToolsService,
    ThotChatService,
    ThotExamplesService,
    ThotExampleVectorService,
    EmbeddingsService,
  ],
  exports: [
    Customer360Service,
    DecisionEngineService,
    CommerceAgentService,
    FeedbackService,
    ThotService,
    PushDirectivesService,
    CommercialFindingsService,
    CommercialDiagnosisService,
    CommercialActionsService,
    CommercialCalibrationService,
    AutonomyService,
  ],
})
export class CommercialIntelligenceModule {}
