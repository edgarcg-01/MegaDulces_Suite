import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { Customer360Service } from './customer-360.service';
import { Customer360RefreshService } from './customer-360-refresh.service';
import { DecisionEngineService } from './decision-engine.service';
import { CommerceAgentService } from './commerce-agent.service';
import { FeedbackService, RecordSignalDto } from './feedback.service';
import { ThotService } from './thot.service';
import { PushDirectivesService, CreateDirectiveDto } from './push-directives.service';
import { CommercialFindingsService } from './commercial-findings.service';
import { CommercialDiagnosisService } from './commercial-diagnosis.service';
import { CommercialActionsService } from './commercial-actions.service';
import { CommercialCalibrationService } from './commercial-calibration.service';
import { AutonomyService } from './autonomy.service';
import { ThotChatService, ThotChatTurn } from './thot-chat/thot-chat.service';
import { ThotToolsService } from './thot-chat/thot-tools.service';
import { PortalThotToolsService } from './thot-chat/portal-thot-tools.service';
import { VendorThotToolsService } from './thot-chat/vendor-thot-tools.service';
import { ThotScope, PH_FULFILLMENT_WAREHOUSE } from './thot-chat/thot-tool-provider';

@ApiTags('commercial-intelligence')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/intelligence')
export class CommercialIntelligenceController {
  constructor(
    private readonly customer360: Customer360Service,
    private readonly refresh: Customer360RefreshService,
    private readonly engine: DecisionEngineService,
    private readonly agent: CommerceAgentService,
    private readonly feedback: FeedbackService,
    private readonly thot: ThotService,
    private readonly directives: PushDirectivesService,
    private readonly findings: CommercialFindingsService,
    private readonly diagnosis: CommercialDiagnosisService,
    private readonly actions: CommercialActionsService,
    private readonly calibration: CommercialCalibrationService,
    private readonly autonomy: AutonomyService,
    private readonly chat: ThotChatService,
    private readonly adminTools: ThotToolsService,
    private readonly portalTools: PortalThotToolsService,
    private readonly vendorTools: VendorThotToolsService,
  ) {}

  // ─── Thot T.2: empuje dirigido (el negocio decide qué empujar) ───

  @Get('directives')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_VER)
  @ApiOperation({ summary: 'Lista las directrices de empuje (marca foco / producto / categoría) con su target.' })
  listDirectives() {
    return this.directives.list();
  }

  @Get('directives/brands')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Marcas comerciales (picker de marca foco). ?search=' })
  directiveBrands(@Query('search') search?: string) {
    return this.directives.listBrands(search);
  }

  @Post('directives')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Crea una directriz de empuje (focus_brand / manual_product / manual_category).' })
  createDirective(@Body() body: CreateDirectiveDto) {
    return this.directives.create(body);
  }

  @Patch('directives/:id')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Edita una directriz (boost / reason / sponsor / active / valid_to).' })
  updateDirective(
    @Param('id') id: string,
    @Body() body: { boost?: number; reason?: string; sponsor?: string; active?: boolean; valid_to?: string | null },
  ) {
    return this.directives.update(id, body);
  }

  @Delete('directives/:id')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Elimina (soft) una directriz de empuje.' })
  removeDirective(@Param('id') id: string) {
    return this.directives.remove(id);
  }

  // ─── Thot: recomendación producto-first (afinidad + zona + rotación + margen) ───

  @Get('thot/suggest/:customer_id')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Thot sugiere qué ofrecer a un cliente. ?cart=id,id (afinidad/completá canasta) · ?zona= · ?limit= · ?log=<canal> registra la oferta (items+reason) para el feedback loop',
  })
  async thotSuggest(
    @Param('customer_id') customerId: string,
    @Query('cart') cart?: string,
    @Query('zona') zona?: string,
    @Query('limit') limit?: string,
    @Query('log') log?: string,
  ) {
    const suggestions = await this.thot.suggest(customerId, {
      cartProductIds: cart ? cart.split(',').filter(Boolean) : [],
      zona: zona || null,
      limit: limit ? parseInt(limit, 10) || 12 : 12,
    });
    // Feedback loop: registrar la oferta con sus items+reason (atribución product-level).
    // Best-effort: el log nunca debe romper la recomendación. El caller pasa ?log solo
    // en la carga inicial (no en recálculos por carrito) para no inflar impresiones.
    if (log && suggestions.length > 0) {
      this.feedback
        .record({
          customer_id: customerId,
          signal_type: 'offer_shown',
          channel: log.slice(0, 20),
          context: { source: 'thot', items: suggestions.map((s) => ({ p: s.product_id, r: s.reason })) },
        })
        .catch(() => undefined);
    }
    return suggestions;
  }

  // ─── Thot T.R0: findings comerciales (portafolio/distribución + churn) ───

  @Get('findings')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Findings comerciales del motor (default open): dead-stock priceado, margen rezagado, brecha de distribución, churn. ?status= ?severity= ?subject_type=',
  })
  listFindings(
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('subject_type') subjectType?: string,
  ) {
    return this.findings.listFindings({ status, severity, subject_type: subjectType });
  }

  @Post('findings/compute')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Recomputa los findings comerciales del tenant actual (on-demand).' })
  computeFindings() {
    return this.findings.generateForTenant();
  }

  @Post('findings/:id/review')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Descarta/confirma/revisa un finding comercial (feedback humano).' })
  reviewFinding(@Param('id') id: string, @Body() body: { status: string }) {
    return this.findings.reviewFinding(id, body?.status);
  }

  // ─── Thot T.R1: diagnóstico de causa raíz (correlación de findings) ───

  @Get('diagnoses')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Diagnósticos de causa raíz comercial (correlación de ≥2 findings del mismo sujeto). Default open.' })
  listDiagnoses(@Query('status') status?: string) {
    return this.diagnosis.list({ status });
  }

  @Post('diagnoses/compute')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Recomputa los diagnósticos de causa raíz del tenant (sobre los findings abiertos).' })
  computeDiagnoses() {
    return this.diagnosis.generateForTenant();
  }

  @Post('diagnoses/:id/review')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Descarta/confirma/revisa un diagnóstico de causa raíz comercial.' })
  reviewDiagnosis(@Param('id') id: string, @Body() body: { status: string }) {
    return this.diagnosis.review(id, body?.status);
  }

  // ─── Thot T.R2: co-piloto comercial (acciones con confianza/impacto$/prioridad) ───

  @Get('actions')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Acciones del co-piloto comercial (default pending_approval), ordenadas por prioridad. ?kind=finding|diagnosis' })
  listActions(@Query('status') status?: string, @Query('kind') kind?: string) {
    return this.actions.listActions({ status, kind });
  }

  @Post('actions/compute')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Propone acciones del co-piloto desde diagnósticos + findings abiertos (N→1).' })
  computeActions() {
    return this.actions.proposeForTenant();
  }

  @Get('actions/:id/explain')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'T.R3: explica el razonamiento de una acción (cadena determinista + redacción del agente, fallback sin LLM).' })
  explainAction(@Param('id') id: string) {
    return this.agent.explainAction(id);
  }

  @Post('actions/:id/approve')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Aprueba una acción (ejecutor interno: push_product crea push_directive real; resto nota interna).' })
  approveAction(@Param('id') id: string) {
    return this.actions.approveAction(id);
  }

  @Post('actions/:id/reject')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza una acción del co-piloto comercial.' })
  rejectAction(@Param('id') id: string) {
    return this.actions.rejectAction(id);
  }

  // ─── Thot T.L2: aprendizaje (calibración de reglas por feedback humano) ───

  @Get('learning/rules')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'T.L2: scorecard de precisión por regla — qué findings comerciales sirven (aprende de confirm/dismiss).' })
  learningRules() {
    return this.calibration.list();
  }

  @Post('learning/recompute')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'T.L2: recomputa la calibración de reglas del tenant (on-demand).' })
  learningRecompute() {
    return this.calibration.computeForTenant();
  }

  @Post('learning/rules/:findingType/override')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'T.L2: pin humano de una regla (enabled | suppressed | null). El learner no lo pisa.' })
  learningOverride(@Param('findingType') findingType: string, @Body() body: { override?: string | null }) {
    return this.calibration.setOverride(findingType, body?.override ?? null);
  }

  // ─── Thot ADR-022: autonomía acotada (el dial + auto-ejecución + auditoría) ───

  @Get('autonomy/policies')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Dial de autonomía por action_type (off/dry_run/auto + min_confidence/daily_cap/value_cap). __global__ = kill-switch.' })
  autonomyPolicies() {
    return this.autonomy.list();
  }

  @Patch('autonomy/policies/:actionType')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Ajusta el dial de un action_type (o __global__): mode/min_confidence/daily_cap/value_cap_mxn. Default OFF.' })
  setAutonomyPolicy(
    @Param('actionType') actionType: string,
    @Body() body: { mode?: string; min_confidence?: number; daily_cap?: number; value_cap_mxn?: number | null },
  ) {
    return this.autonomy.setPolicy(actionType, body);
  }

  @Post('autonomy/run')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Pasa por las acciones pendientes y auto-ejecuta las que el dial habilite (kill-switch + confianza + caps).' })
  autonomyRun() {
    return this.actions.runAutonomy();
  }

  @Get('autonomy/log')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Panel "Thot actuó solo": acciones auto-ejecutadas (auditoría post-hoc + base para deshacer).' })
  autonomyLog() {
    return this.autonomy.autoLog();
  }

  // ─── Customer 360 (feature store) ───

  @Get('customer-360/my')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Customer 360 del JWT (Portal B2B). Recomputa si stale (>24h).' })
  my() {
    return this.customer360.getForMyCustomer();
  }

  @Get('customer-360/:customer_id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Customer 360 de un customer (admin/vendor). Recomputa si stale.' })
  getForCustomer(@Param('customer_id') customerId: string) {
    return this.customer360.getForCustomer(customerId);
  }

  @Post('customer-360/:customer_id/compute')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Forzar recómputo del Customer 360 de un customer' })
  compute(@Param('customer_id') customerId: string) {
    return this.customer360.computeForCustomer(customerId);
  }

  @Post('customer-360/refresh')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Trigger manual del cron: recomputa customer_360 de TODOS los tenants (admin)' })
  refreshAll() {
    return this.refresh.refreshAllTenants();
  }

  // ─── Next-Best-Action (Motor de Decisión) ───

  @Get('nba')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Customers due-for-reorder hoy (más urgentes primero). Para vendor/admin.' })
  nbaList(@Query('limit') limit?: string) {
    return this.engine.listDueForReorder(limit ? parseInt(limit, 10) || 50 : 50);
  }

  @Get('nba/:customer_id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Next-Best-Action de un customer (¿toca reorden?)' })
  nba(@Param('customer_id') customerId: string) {
    return this.engine.nextBestAction(customerId);
  }

  @Get('nba/:customer_id/basket')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Canasta sugerida de reorden (categoría base de la canasta estratégica)' })
  basket(@Param('customer_id') customerId: string) {
    return this.engine.suggestedBasket(customerId);
  }

  @Get('nba/:customer_id/message')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Mensaje de reorden redactado (agente). Datos del motor; Claude solo redacta, fallback a plantilla.' })
  message(@Param('customer_id') customerId: string) {
    return this.agent.composeReorderMessage(customerId);
  }

  // ─── Feedback loop (oferta → resultado) ───

  @Post('signals')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Registra una señal del feedback loop (oferta/impresión) para un customer.' })
  recordSignal(@Body() dto: RecordSignalDto) {
    return this.feedback.record(dto);
  }

  @Post('signals/my')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Registra una señal para el customer del JWT (Portal B2B).' })
  recordMySignal(@Body() dto: { signal_type: string; channel: string; context?: Record<string, unknown> }) {
    return this.feedback.recordForMyCustomer(dto);
  }

  @Get('signals/summary')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Conversión del feedback loop: ofertas → pedidos en ventana (default 30d).' })
  signalsSummary(@Query('days') days?: string) {
    return this.feedback.conversionSummary(days ? parseInt(days, 10) || 30 : 30);
  }

  @Get('signals/daily')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Serie diaria de conversión (ofertas/convertidas por día) para mini-charts.' })
  signalsDaily(@Query('days') days?: string) {
    return this.feedback.conversionDaily(days ? parseInt(days, 10) || 30 : 30);
  }

  @Get('signals/conversion-by-reason')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary: 'Conversión ATRIBUIDA por razón de Thot (whitespace/recompra/afinidad/...). Producto ofrecido → comprado en ventana. ?days= ?attribution_days=',
  })
  conversionByReason(@Query('days') days?: string, @Query('attribution_days') attr?: string) {
    return this.feedback.conversionByReason(
      days ? parseInt(days, 10) || 30 : 30,
      attr ? parseInt(attr, 10) || 7 : 7,
    );
  }

  // ─── TC.2 (ADR-026): Thot Chat — analítica conversacional sobre ventas ───

  @Post('thot/chat')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Chat analítico ADMIN (todo el tenant). Back-office only. Stateless: enviar `history`.' })
  async thotChat(
    @Req() req: any,
    @Body() body: { history?: ThotChatTurn[]; message?: string; think?: boolean; deep_search?: boolean },
  ) {
    // TC-S hardening: aunque customer_b2b/vendedor tengan COMMERCIAL_ORDERS_VER, el
    // perfil ADMIN ve TODO el tenant (márgenes, todos los clientes). Esas audiencias
    // tienen su propio endpoint scoped (/portal/thot/chat, /vendor/thot/chat).
    const role = req.user?.roleName || req.user?.role_name;
    if (role === 'customer_b2b' || role === 'vendedor') {
      throw new ForbiddenException('Usá el asistente de tu app (portal/vendedor).');
    }
    const history: ThotChatTurn[] = Array.isArray(body?.history) ? body.history : [];
    if (body?.message) history.push({ role: 'user', content: String(body.message) });
    const userName = req.user?.full_name || req.user?.username || undefined;
    const scope: ThotScope = { profile: 'admin', userName };
    const result = await this.chat.ask(this.adminTools, scope, {
      history,
      think: !!body?.think,
      deepSearch: !!body?.deep_search,
    });
    const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    await this.chat.logExchange({ userId: req.user?.id, userName, profile: 'admin', question: lastQuestion }, result);
    return result;
  }

  // ─── Portal B2B: chat scoped al cliente del JWT (sin márgenes, surtido PH) ───
  @Post('portal/thot/chat')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Chat del Portal B2B. Scoped al cliente del JWT; surtido PH; sin datos de terceros ni márgenes.' })
  async portalThotChat(@Req() req: any, @Body() body: { history?: ThotChatTurn[]; message?: string }) {
    const customerId = req.user?.customer_id;
    if (!customerId) throw new ForbiddenException('Tu usuario no está enlazado a un cliente.');
    const history: ThotChatTurn[] = Array.isArray(body?.history) ? body.history : [];
    if (body?.message) history.push({ role: 'user', content: String(body.message) });
    const userName = req.user?.full_name || req.user?.username || undefined;
    const scope: ThotScope = { profile: 'portal', customerId, warehouseCode: PH_FULFILLMENT_WAREHOUSE, userName };
    const result = await this.chat.ask(this.portalTools, scope, { history });
    const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    await this.chat.logExchange({ userId: req.user?.id, userName, profile: 'portal', question: lastQuestion }, result);
    return result;
  }

  // ─── Vendedor: chat scoped a su cartera (surtido PH) ───
  @Post('vendor/thot/chat')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({ summary: 'Chat del vendedor. Scoped a su cartera/ruta; surtido PH.' })
  async vendorThotChat(@Req() req: any, @Body() body: { history?: ThotChatTurn[]; message?: string }) {
    const history: ThotChatTurn[] = Array.isArray(body?.history) ? body.history : [];
    if (body?.message) history.push({ role: 'user', content: String(body.message) });
    const userName = req.user?.full_name || req.user?.username || undefined;
    const scope: ThotScope = { profile: 'vendor', vendorUserId: req.user?.id, warehouseCode: PH_FULFILLMENT_WAREHOUSE, userName };
    const result = await this.chat.ask(this.vendorTools, scope, { history });
    const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    await this.chat.logExchange({ userId: req.user?.id, userName, profile: 'vendor', question: lastQuestion }, result);
    return result;
  }
}
