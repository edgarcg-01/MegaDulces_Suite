import { Module } from '@nestjs/common';
import { SupervisorAiController } from './supervisor-ai.controller';
import { SupervisorFieldController } from './supervisor-field.controller';
import { Execution360Service } from './execution-360.service';
import { ExecutionRefreshService } from './execution-refresh.service';
import { FindingsEngineService } from './findings-engine.service';
import { DiagnosisEngineService } from './diagnosis-engine.service';
import { SupervisorAgentService } from './supervisor-agent.service';
import { SupervisorActionsService } from './supervisor-actions.service';
import { OpportunityEngineService } from './opportunity-engine.service';
import { PhotoAuditService } from './photo-audit.service';
import { FraudEngineService } from './fraud-engine.service';
import { ScoringEngineService } from './scoring-engine.service';
import { SalesExecutionService } from './sales-execution.service';
import { RuleCalibrationService } from './rule-calibration.service';
import { BaselineLearnerService } from './baseline-learner.service';
import { OutcomeVerifierService } from './outcome-verifier.service';
import { HorusChatService } from './horus-chat/horus-chat.service';
import { HorusToolsService } from './horus-chat/horus-tools.service';

/**
 * Horus — Supervisor AI de ejecución (Trade Marketing). Read-only/compute sobre
 * daily_captures (connection legacy, mismo que ReportsModule/CommercialMapModule)
 * + feature store commercial.execution_360 + motor de findings. El @Cron de
 * ExecutionRefreshService usa ScheduleModule.forRoot() (global en app.module).
 * No requiere providers extra: KNEX_CONNECTION y TenantContextService vienen de
 * módulos globales.
 */
@Module({
  controllers: [SupervisorAiController, SupervisorFieldController],
  providers: [
    Execution360Service,
    ExecutionRefreshService,
    FindingsEngineService,
    DiagnosisEngineService,
    SupervisorAgentService,
    SupervisorActionsService,
    OpportunityEngineService,
    PhotoAuditService,
    FraudEngineService,
    ScoringEngineService,
    SalesExecutionService,
    RuleCalibrationService,
    BaselineLearnerService,
    OutcomeVerifierService,
    HorusChatService,
    HorusToolsService,
  ],
  exports: [Execution360Service, FindingsEngineService],
})
export class SupervisorAiModule {}
