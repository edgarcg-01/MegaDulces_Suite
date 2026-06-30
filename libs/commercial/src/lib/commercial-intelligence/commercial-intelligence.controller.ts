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
  Logger,
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
import { ThotExamplesService } from './thot-chat/thot-examples.service';
import { ThotScope, PH_FULFILLMENT_WAREHOUSE } from './thot-chat/thot-tool-provider';

@ApiTags('commercial-intelligence')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/intelligence')
export class CommercialIntelligenceController {
  private readonly logger = new Logger(CommercialIntelligenceController.name);

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
    private readonly examples: ThotExamplesService,
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
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Chat analítico ADMIN (todo el tenant). Back-office only. Stateless: enviar `history`.' })
  async thotChat(
    @Req() req: any,
    @Body() body: {
      history?: ThotChatTurn[];
      message?: string;
      think?: boolean;
      deep_search?: boolean;
      image?: { media_type?: string; data?: string };
    },
  ) {
    // TC-S hardening: el perfil ADMIN ve TODO el tenant (márgenes, todos los
    // clientes). Se gatea por COMMERCIAL_CUSTOMERS_GESTIONAR (gestión back-office):
    // customer_b2b y vendedores de campo NO lo tienen (aunque sí ORDERS_VER) y
    // quedan fuera; usan sus endpoints scoped (/portal, /vendor). Gatear por permiso
    // —no por nombre de rol— es robusto ante roles custom de prod (p.ej.
    // supervisor_ventas, que SÍ es gestión y debe entrar).
    const history: ThotChatTurn[] = Array.isArray(body?.history) ? body.history : [];
    if (body?.message) history.push({ role: 'user', content: String(body.message) });
    const userName = req.user?.full_name || req.user?.username || undefined;
    const scope: ThotScope = { profile: 'admin', userName };
    const image = body?.image?.data && body?.image?.media_type
      ? { mediaType: body.image.media_type, data: body.image.data }
      : undefined;
    const result = await this.chat.ask(this.adminTools, scope, {
      history,
      think: !!body?.think,
      deepSearch: !!body?.deep_search,
      image,
    });
    const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    const logId = await this.chat.logExchange({ userId: req.user?.id, userName, profile: 'admin', question: lastQuestion }, result);
    return { ...result, log_id: logId };
  }

  // ─── Dictado por voz: transcribe audio → texto (Groq Whisper) ───
  // Proxy fino: el front graba con MediaRecorder y manda el audio en base64; acá
  // lo reenviamos a Groq (la API key vive solo en el server). Calidad Whisper.
  @Post('thot/transcribe')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Transcribe audio de dictado a texto (Groq Whisper large-v3-turbo).' })
  async transcribe(@Body() body: { audio?: string; mime?: string }) {
    const b64 = body?.audio || '';
    if (!b64) return { text: '' };
    const key = process.env.GROQ_API_KEY || '';
    if (!key) return { text: '', error: 'no_key' };

    const buf = Buffer.from(b64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: body?.mime || 'audio/webm' }), 'audio.webm');
    form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
    form.append('language', 'es');
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        this.logger.warn(`Groq STT HTTP ${res.status}: ${txt.slice(0, 200)}`);
        return { text: '', error: 'stt_failed' };
      }
      const json: any = await res.json();
      return { text: (json?.text || '').trim() };
    } catch (e: any) {
      this.logger.warn(`Groq STT error: ${e?.message || e}`);
      return { text: '', error: 'stt_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Portal B2B: chat scoped al cliente del JWT (sin márgenes, surtido PH) ───
  @Post('portal/thot/chat')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Chat del Portal B2B. Scoped al cliente del JWT; surtido PH; sin datos de terceros ni márgenes.' })
  async portalThotChat(@Req() req: any, @Body() body: { history?: ThotChatTurn[]; message?: string }) {
    // El customer_id del cliente NO viene en req.user; el provider lo resuelve por
    // public.users.customer_id (ctx.userId), igual que /orders/my.
    const history: ThotChatTurn[] = Array.isArray(body?.history) ? body.history : [];
    if (body?.message) history.push({ role: 'user', content: String(body.message) });
    const userName = req.user?.full_name || req.user?.username || undefined;
    const scope: ThotScope = { profile: 'portal', customerId: req.user?.customer_id ?? null, warehouseCode: PH_FULFILLMENT_WAREHOUSE, userName };
    const result = await this.chat.ask(this.portalTools, scope, { history });
    const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    const logId = await this.chat.logExchange({ userId: req.user?.id, userName, profile: 'portal', question: lastQuestion }, result);
    return { ...result, log_id: logId };
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
    const logId = await this.chat.logExchange({ userId: req.user?.id, userName, profile: 'vendor', question: lastQuestion }, result);
    return { ...result, log_id: logId };
  }

  // ─── TC.5a: feedback 👍/👎 sobre una respuesta (alimenta la curaduría) ───
  @Post('thot/feedback')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Registra 👍/👎 sobre una respuesta de Thot. body: { log_id, vote: 1|-1 }' })
  thotFeedback(@Body() body: { log_id?: string; vote?: number }) {
    if (!body?.log_id) return { ok: false };
    return this.chat.recordFeedback(String(body.log_id), Number(body.vote) || 0);
  }

  // ─── TC.4a: biblioteca de ejemplos verificados (few-shot). Back-office. ───
  @Get('thot/examples')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Lista los ejemplos verificados (few-shot). ?profile=admin|portal|vendor' })
  listExamples(@Query('profile') profile?: string) {
    return this.examples.list(profile);
  }

  @Get('thot/examples/candidates')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Cola de curaduría: respuestas con 👍 aún no promovidas a ejemplo.' })
  exampleCandidates(@Query('limit') limit?: string) {
    return this.examples.candidates(limit ? parseInt(limit, 10) : undefined);
  }

  @Post('thot/examples')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Agrega un ejemplo dorado (pregunta → tools → respuesta modelo).' })
  addExample(@Req() req: any, @Body() body: { profile?: string; question: string; answer?: string; tools?: any[]; note?: string }) {
    return this.examples.add(body, req.user?.id);
  }

  @Post('thot/examples/from-log/:logId')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Promueve una conversación del log a ejemplo dorado.' })
  promoteExample(@Req() req: any, @Param('logId') logId: string, @Body() body: { note?: string; profile?: string }) {
    return this.examples.promoteFromLog(logId, body || {}, req.user?.id);
  }

  @Patch('thot/examples/:id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Habilita/deshabilita un ejemplo.' })
  toggleExample(@Param('id') id: string, @Body() body: { enabled: boolean }) {
    return this.examples.setEnabled(id, !!body?.enabled);
  }
}
