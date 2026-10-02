/**
 * `[MS.2.3]` HTTP de la Mesa de Servicio. ADR-081.
 *
 * El permiso de la RUTA es sólo la puerta; QUIÉN puede hacer qué sobre cada ticket (solicitante / quien
 * atiende / coordinación) lo decide el servicio contra la máquina de estados. Por eso confirmar, reabrir y
 * cancelar piden `SERVICIO_REPORTAR` — es lo que tiene el solicitante — y el servicio rechaza al que no
 * corresponde.
 *
 * Orden: las rutas literales (`mine`, `inbox`, `stats`) van ANTES de `:id`, o `:id` se las traga.
 */
import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type SdAgentDto,
  type SdAssignDto,
  type SdCatalogResponse,
  type SdChangePriorityDto,
  type SdChangeStatusDto,
  type SdConfigResponse,
  type SdCreateRequestDto,
  type SdListResponse,
  type SdNotificationDto,
  type SdPreferencesDto,
  type SdSettingsDto,
  type SdSlaPolicyDto,
  type SdSlaScanResult,
  type SdUpdatePreferencesDto,
  type SdUpsertCategoryDto,
  type SdUpsertQueueDto,
  type SdLogTimeDto,
  type SdPostMessageDto,
  type SdRequestDetail,
  type SdStatsResponse,
} from '@megadulces/contracts';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import { ServiceDeskActorsService } from './actors.service';
import { ServiceDeskAgentsService } from './agents.service';
import { ServiceDeskConfigAdminService } from './config-admin.service';
import { ServiceDeskNotificationsService } from './notifications.service';
import { ServiceDeskPreferencesService } from './preferences.service';
import { ServiceDeskSlaService } from './sla.service';
import { ServiceDeskConfigService } from './service-desk-config.service';
import { ServiceDeskRequestsService } from './requests.service';
import { actorDesdeRequest, type AuthedRequest } from './service-desk.types';

const num = (v?: string): number | undefined => (v === undefined || v === '' ? undefined : Number(v));

@ApiTags('service-desk')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('service-desk')
export class ServiceDeskController {
  constructor(
    private readonly requests: ServiceDeskRequestsService,
    private readonly config: ServiceDeskConfigService,
    private readonly agents: ServiceDeskAgentsService,
    private readonly notifs: ServiceDeskNotificationsService,
    private readonly prefs: ServiceDeskPreferencesService,
    private readonly admin: ServiceDeskConfigAdminService,
    private readonly sla: ServiceDeskSlaService,
    private readonly actors: ServiceDeskActorsService,
  ) {}

  @Get('catalog')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Colas, categorías e impactos para la pantalla «Nueva solicitud».' })
  catalog(): Promise<SdCatalogResponse> {
    return this.config.catalog();
  }

  @Get('agents')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Personas asignables, con su carga abierta.' })
  agentsList(): Promise<SdAgentDto[]> {
    return this.agents.list();
  }

  @Post('requests')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Crea una solicitud. La prioridad se SUGIERE (categoría × impacto × bloqueo).' })
  create(@Body() dto: SdCreateRequestDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.create(ctx, dto));
  }

  @Get('requests/mine')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Mis solicitudes (las que yo reporté).' })
  mine(
    @Query('scope') scope: string | undefined,
    @Query('search') search: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<SdListResponse> {
    return this.actors.resolve(req).then((ctx) => this.requests.listMine(ctx, { scope, search, limit: num(limit), offset: num(offset) }));
  }

  @Get('requests/inbox')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Bandeja de quien atiende: prioridad → vencimiento → antigüedad.' })
  inbox(
    @Query('scope') scope: string | undefined,
    @Query('queue_id') queue_id: string | undefined,
    @Query('priority') priority: string | undefined,
    @Query('status') status: string | undefined,
    @Query('warehouse_code') warehouse_code: string | undefined,
    @Query('search') search: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<SdListResponse> {
    return this.actors.resolve(req).then((ctx) => this.requests.inbox(ctx, { scope, queue_id, priority, status, warehouse_code, search, limit: num(limit), offset: num(offset) }));
  }

  @Get('requests/stats')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Tablero: abiertas, sin asignar y fuera de plazo.' })
  stats(@Req() req: AuthedRequest): Promise<SdStatsResponse> {
    return this.actors.resolve(req).then((ctx) => this.requests.stats(ctx));
  }

  @Get('requests/:id')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Detalle con hilo y adjuntos. Las notas internas sólo las ve quien atiende.' })
  detail(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.detail(ctx, id));
  }

  @Post('requests/:id/messages')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Comenta (o deja una nota interna si atiendes).' })
  message(@Param('id') id: string, @Body() dto: SdPostMessageDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.postMessage(ctx, id, dto));
  }

  @Post('requests/:id/status')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Cambia el estado. La máquina de estados decide quién puede qué.' })
  status(@Param('id') id: string, @Body() dto: SdChangeStatusDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.changeStatus(ctx, id, dto));
  }

  @Post('requests/:id/confirm')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'El solicitante confirma que quedó resuelto y se cierra.' })
  confirm(@Param('id') id: string, @Body() dto: { note?: string }, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.confirm(ctx, id, dto?.note));
  }

  @Post('requests/:id/reopen')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Reabre una solicitud resuelta (exige decir qué sigue fallando).' })
  reopen(@Param('id') id: string, @Body() dto: { note?: string }, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.reopen(ctx, id, dto?.note));
  }

  @Post('requests/:id/cancel')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Cancela la solicitud (el solicitante antes de que se trabaje; la coordinación siempre).' })
  cancel(@Param('id') id: string, @Body() dto: { note?: string }, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.cancel(ctx, id, dto?.note));
  }

  @Post('requests/:id/take')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Tomar una solicitud sin asignar.' })
  take(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.take(ctx, id));
  }

  @Post('requests/:id/assign')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'La coordinación asigna o reasigna a quien atiende.' })
  assign(@Param('id') id: string, @Body() dto: SdAssignDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.assign(ctx, id, dto));
  }

  @Post('requests/:id/priority')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Cambia la prioridad (recalcula los plazos). El solicitante no puede.' })
  priority(@Param('id') id: string, @Body() dto: SdChangePriorityDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.changePriority(ctx, id, dto));
  }

  @Post('requests/:id/time')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Registra tiempo trabajado (paridad con la Bitácora de Sistemas).' })
  time(@Param('id') id: string, @Body() dto: SdLogTimeDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.actors.resolve(req).then((ctx) => this.requests.logTime(ctx, id, dto));
  }

  // ── Avisos y preferencias de cada persona ──

  @Get('me/notifications')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Mis avisos (la campana los recoge por poll; `since` evita releer lo ya mostrado).' })
  myNotifications(@Query('since') since: string | undefined, @Query('limit') limit: string | undefined, @Req() req: AuthedRequest): Promise<SdNotificationDto[]> {
    return this.notifs.listApp(actorDesdeRequest(req).userId, since, num(limit));
  }

  @Get('me/preferences')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Mi correo, mi teléfono y por dónde quiero que me avisen.' })
  myPreferences(@Req() req: AuthedRequest): Promise<SdPreferencesDto> {
    return this.prefs.get(actorDesdeRequest(req).userId);
  }

  @Put('me/preferences')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Actualiza MIS datos de contacto y avisos. WhatsApp exige teléfono y deja fecha de consentimiento.' })
  updateMyPreferences(@Body() dto: SdUpdatePreferencesDto, @Req() req: AuthedRequest): Promise<SdPreferencesDto> {
    return this.prefs.update(actorDesdeRequest(req), dto);
  }

  // ── Configuración y SLA (coordinación) ──

  @Get('config')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Horario hábil, políticas de SLA, colas y categorías (incluye las apagadas).' })
  getConfig(): Promise<SdConfigResponse> {
    return this.admin.get();
  }

  @Put('config/settings')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Cambia el horario hábil, el auto-cierre o enciende la escalación (apagada de fábrica).' })
  updateSettings(@Body() dto: Partial<SdSettingsDto>, @Req() req: AuthedRequest): Promise<SdConfigResponse> {
    return this.admin.updateSettings(actorDesdeRequest(req), dto);
  }

  @Put('config/policies/:priority')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Cambia los plazos y el reloj (hábil/corrido) de una prioridad.' })
  updatePolicy(@Param('priority') priority: string, @Body() dto: Partial<Omit<SdSlaPolicyDto, 'priority'>>, @Req() req: AuthedRequest): Promise<SdConfigResponse> {
    return this.admin.updatePolicy(actorDesdeRequest(req), priority, dto);
  }

  @Post('config/queues')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Alta de una cola (departamento que atiende). El modelo es multi-cola; hoy sólo existe TI.' })
  createQueue(@Body() dto: SdUpsertQueueDto, @Req() req: AuthedRequest): Promise<SdConfigResponse> {
    return this.admin.createQueue(actorDesdeRequest(req), dto);
  }

  @Put('config/queues/:id')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Renombra, ordena o apaga una cola.' })
  updateQueue(@Param('id') id: string, @Body() dto: SdUpsertQueueDto, @Req() req: AuthedRequest): Promise<SdConfigResponse> {
    return this.admin.updateQueue(actorDesdeRequest(req), id, dto);
  }

  @Post('config/categories')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Alta de una categoría con su prioridad por defecto.' })
  createCategory(@Body() dto: SdUpsertCategoryDto, @Req() req: AuthedRequest): Promise<SdConfigResponse> {
    return this.admin.createCategory(actorDesdeRequest(req), dto);
  }

  @Put('config/categories/:id')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Edita o apaga una categoría. Apagar no borra: los tickets viejos la conservan.' })
  updateCategory(@Param('id') id: string, @Body() dto: SdUpsertCategoryDto, @Req() req: AuthedRequest): Promise<SdConfigResponse> {
    return this.admin.updateCategory(actorDesdeRequest(req), id, dto);
  }

  @Post('sla/scan-now')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Barre el SLA de mi tenant AHORA, por el mismo camino que el cron (deja latido).' })
  scanNow(): Promise<SdSlaScanResult> {
    return this.sla.scanNow();
  }
}
