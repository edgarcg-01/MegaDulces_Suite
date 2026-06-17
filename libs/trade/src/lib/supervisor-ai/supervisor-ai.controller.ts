import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  ReqUser,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import { Execution360Service } from './execution-360.service';
import { FindingsEngineService } from './findings-engine.service';
import { SupervisorAgentService } from './supervisor-agent.service';
import { SupervisorActionsService } from './supervisor-actions.service';
import { OpportunityEngineService } from './opportunity-engine.service';
import { PhotoAuditService } from './photo-audit.service';
import { FraudEngineService } from './fraud-engine.service';
import { ScoringEngineService } from './scoring-engine.service';
import { SalesExecutionService } from './sales-execution.service';
import { RuleCalibrationService } from './rule-calibration.service';
import { ListExecution360Dto } from './dto/execution-360-filter.dto';
import { ListFindingsDto, ReviewFindingDto } from './dto/findings.dto';

/**
 * Horus — Supervisor AI de ejecución (Trade). Sprints Horus.0 (feature store) +
 * Horus.1 (motor de findings). Read-only/compute sobre commercial.execution_360
 * y commercial.supervisor_findings. Conexión legacy (KNEX_CONNECTION) + tenant_id
 * explícito, como CommercialMap.
 */
@ApiTags('supervisor-ai')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('supervisor-ai')
export class SupervisorAiController {
  constructor(
    private readonly exec360: Execution360Service,
    private readonly findings: FindingsEngineService,
    private readonly agent: SupervisorAgentService,
    private readonly actions: SupervisorActionsService,
    private readonly opportunities: OpportunityEngineService,
    private readonly photoAudit: PhotoAuditService,
    private readonly fraud: FraudEngineService,
    private readonly scoring: ScoringEngineService,
    private readonly salesExec: SalesExecutionService,
    private readonly ruleCalibration: RuleCalibrationService,
  ) {}

  @Get('execution-360')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({
    summary: 'Feature store de ejecución (collaborator/route/store × ventana 7/30d)',
  })
  listExecution360(@ReqUser() user: any, @Query() filters: ListExecution360Dto) {
    return this.exec360.list(filters, user);
  }

  @Get('findings')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Hallazgos del motor (default open), priorizados por severidad' })
  listFindings(@ReqUser() user: any, @Query() filters: ListFindingsDto) {
    return this.findings.listFindings(filters, user);
  }

  @Post('findings/:id/review')
  @RequirePermissions(Permission.SUPERVISOR_AI_APROBAR)
  @ApiOperation({ summary: 'Descarta/confirma/revisa un hallazgo (feedback loop, co-piloto)' })
  reviewFinding(@ReqUser() user: any, @Param('id') id: string, @Body() body: ReviewFindingDto) {
    return this.findings.reviewFinding(id, body.status, user);
  }

  @Get('briefing')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({
    summary: 'Parte diario: el agente redacta sobre los findings (fallback determinista sin LLM)',
  })
  briefing(@ReqUser() user: any) {
    return this.agent.buildBriefing(user);
  }

  @Get('actions')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Acciones del co-piloto (default pending_approval). Filtra ?kind=finding|opportunity' })
  listActions(@ReqUser() user: any, @Query('status') status?: string, @Query('kind') kind?: string) {
    return this.actions.listActions({ status, kind }, user);
  }

  @Get('opportunities')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Mejoras propuestas por el motor (acciones kind=opportunity, default pending)' })
  listOpportunities(@ReqUser() user: any, @Query('status') status?: string) {
    return this.actions.listActions({ status: status || 'pending_approval', kind: 'opportunity' }, user);
  }

  @Get('tasks')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Tareas de campo creadas por el co-piloto (efecto real de aprobar)' })
  listTasks(@ReqUser() user: any, @Query('status') status?: string) {
    return this.actions.listTasks({ status }, user);
  }

  @Get('coaching-notes')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Notas de coaching creadas por el co-piloto (efecto real de aprobar)' })
  listCoachingNotes(@ReqUser() user: any, @Query('status') status?: string) {
    return this.actions.listCoachingNotes({ status }, user);
  }

  @Post('actions/:id/approve')
  @RequirePermissions(Permission.SUPERVISOR_AI_APROBAR)
  @ApiOperation({ summary: 'Aprueba una acción del co-piloto (ejecuta interno + confirma el finding)' })
  approveAction(@ReqUser() user: any, @Param('id') id: string) {
    return this.actions.approveAction(id, user);
  }

  @Post('actions/:id/reject')
  @RequirePermissions(Permission.SUPERVISOR_AI_APROBAR)
  @ApiOperation({ summary: 'Rechaza una acción del co-piloto' })
  rejectAction(@ReqUser() user: any, @Param('id') id: string) {
    return this.actions.rejectAction(id, user);
  }

  @Post('compute')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({
    summary: 'Recomputa feature store + findings + acciones + mejoras del tenant actual (on-demand)',
  })
  async compute(@ReqUser() user: any) {
    const tenantId = user?.tenant_id;
    const featureStore = await this.exec360.computeForTenant(tenantId);
    const calibration = await this.ruleCalibration.computeForTenant(tenantId); // L2: recalibra antes de emitir
    const findings = await this.findings.generateForTenant(tenantId);
    const fraud = await this.fraud.generateForTenant(tenantId); // determinista, sin LLM
    const actions = await this.actions.proposeForTenant(tenantId);
    const opportunities = await this.opportunities.generateForTenant(tenantId);
    const scoring = await this.scoring.scoreForTenant(tenantId); // usa findings+fraude
    const sales_execution = await this.salesExec.generateGapFindings(tenantId); // gateado por volumen de venta
    const snapshot = await this.exec360.snapshotForTenant(tenantId); // último: captura el estado final (incl. exec_score)
    return { tenant_id: tenantId, feature_store: featureStore, calibration, findings, fraud, actions, opportunities, scoring, sales_execution, snapshot };
  }

  @Post('vision/scan')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({
    summary: 'Visión (H2.2): Claude analiza fotos de exhibición no vistas (acotado) → veredictos + findings',
  })
  async visionScan(@ReqUser() user: any, @Body() body?: { max?: number }) {
    const tenantId = user?.tenant_id;
    const scan = await this.photoAudit.scanForTenant(tenantId, { max: body?.max });
    const visionFindings = await this.photoAudit.generateVisionFindings(tenantId);
    // Las acciones/mejoras del co-piloto incorporan los hallazgos de visión recién emitidos.
    await this.actions.proposeForTenant(tenantId);
    await this.opportunities.generateForTenant(tenantId);
    return { tenant_id: tenantId, scan, vision_findings: visionFindings };
  }

  @Get('vision')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Veredictos de visión por foto (flagged primero). ?flagged=true ?capture_id=' })
  listVision(@ReqUser() user: any, @Query('flagged') flagged?: string, @Query('capture_id') captureId?: string) {
    return this.photoAudit.listVision({ flagged: flagged === 'true', capture_id: captureId }, user);
  }

  @Get('vision/coverage')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Cobertura de visión: fotos totales vs analizadas + banderas (stockout/mismatch/inválidas)' })
  visionCoverage(@ReqUser() user: any) {
    return this.photoAudit.coverage(user);
  }

  @Post('fraud/scan')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({
    summary: 'Fraude (H2.4): reglas deterministas de integridad (GPS/velocidad/tiempo/foto) → findings source=fraud',
  })
  fraudScan(@ReqUser() user: any) {
    return this.fraud.generateForTenant(user?.tenant_id);
  }

  @Get('sales-execution')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({
    summary: 'Venta↔ejecución (H2.7): correlación read-only + cobertura de registro de venta (vendedores/tiendas)',
  })
  salesExecution(@ReqUser() user: any) {
    return this.salesExec.getCorrelation(user);
  }

  @Get('learning/rules')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({
    summary: 'Aprendizaje L2 (ADR-021): scorecard de precisión por regla — qué hallazgos de Horus sirven',
  })
  learningRules(@ReqUser() user: any) {
    return this.ruleCalibration.list(user);
  }

  @Post('learning/recompute')
  @RequirePermissions(Permission.SUPERVISOR_AI_VER)
  @ApiOperation({ summary: 'Aprendizaje L2: recomputa la calibración de reglas del tenant (on-demand)' })
  learningRecompute(@ReqUser() user: any) {
    return this.ruleCalibration.computeForTenant(user?.tenant_id);
  }

  @Post('learning/rules/:findingType/override')
  @RequirePermissions(Permission.SUPERVISOR_AI_APROBAR)
  @ApiOperation({
    summary: 'Aprendizaje L2: pin humano de una regla (enabled | suppressed | null). El learner no lo pisa.',
  })
  learningOverride(
    @ReqUser() user: any,
    @Param('findingType') findingType: string,
    @Body() body: { source?: string; override?: string | null },
  ) {
    return this.ruleCalibration.setOverride(findingType, body?.source || 'engine', body?.override ?? null, user);
  }
}
