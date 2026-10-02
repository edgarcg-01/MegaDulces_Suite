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
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type SdAgentDto,
  type SdAssignDto,
  type SdCatalogResponse,
  type SdChangePriorityDto,
  type SdChangeStatusDto,
  type SdCreateRequestDto,
  type SdListResponse,
  type SdLogTimeDto,
  type SdPostMessageDto,
  type SdRequestDetail,
  type SdStatsResponse,
} from '@megadulces/contracts';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import { ServiceDeskAgentsService } from './agents.service';
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
    return this.requests.create(actorDesdeRequest(req), dto);
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
    return this.requests.listMine(actorDesdeRequest(req), { scope, search, limit: num(limit), offset: num(offset) });
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
    return this.requests.inbox(actorDesdeRequest(req), { scope, queue_id, priority, status, warehouse_code, search, limit: num(limit), offset: num(offset) });
  }

  @Get('requests/stats')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Tablero: abiertas, sin asignar y fuera de plazo.' })
  stats(@Req() req: AuthedRequest): Promise<SdStatsResponse> {
    return this.requests.stats(actorDesdeRequest(req));
  }

  @Get('requests/:id')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Detalle con hilo y adjuntos. Las notas internas sólo las ve quien atiende.' })
  detail(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.detail(actorDesdeRequest(req), id);
  }

  @Post('requests/:id/messages')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Comenta (o deja una nota interna si atiendes).' })
  message(@Param('id') id: string, @Body() dto: SdPostMessageDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.postMessage(actorDesdeRequest(req), id, dto);
  }

  @Post('requests/:id/status')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Cambia el estado. La máquina de estados decide quién puede qué.' })
  status(@Param('id') id: string, @Body() dto: SdChangeStatusDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.changeStatus(actorDesdeRequest(req), id, dto);
  }

  @Post('requests/:id/confirm')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'El solicitante confirma que quedó resuelto y se cierra.' })
  confirm(@Param('id') id: string, @Body() dto: { note?: string }, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.confirm(actorDesdeRequest(req), id, dto?.note);
  }

  @Post('requests/:id/reopen')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Reabre una solicitud resuelta (exige decir qué sigue fallando).' })
  reopen(@Param('id') id: string, @Body() dto: { note?: string }, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.reopen(actorDesdeRequest(req), id, dto?.note);
  }

  @Post('requests/:id/cancel')
  @RequirePermissions(Permission.SERVICIO_REPORTAR)
  @ApiOperation({ summary: 'Cancela la solicitud (el solicitante antes de que se trabaje; la coordinación siempre).' })
  cancel(@Param('id') id: string, @Body() dto: { note?: string }, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.cancel(actorDesdeRequest(req), id, dto?.note);
  }

  @Post('requests/:id/take')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Tomar una solicitud sin asignar.' })
  take(@Param('id') id: string, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.take(actorDesdeRequest(req), id);
  }

  @Post('requests/:id/assign')
  @RequirePermissions(Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'La coordinación asigna o reasigna a quien atiende.' })
  assign(@Param('id') id: string, @Body() dto: SdAssignDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.assign(actorDesdeRequest(req), id, dto);
  }

  @Post('requests/:id/priority')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Cambia la prioridad (recalcula los plazos). El solicitante no puede.' })
  priority(@Param('id') id: string, @Body() dto: SdChangePriorityDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.changePriority(actorDesdeRequest(req), id, dto);
  }

  @Post('requests/:id/time')
  @RequireAnyPermission(Permission.SERVICIO_ATENDER, Permission.SERVICIO_COORDINAR)
  @ApiOperation({ summary: 'Registra tiempo trabajado (paridad con la Bitácora de Sistemas).' })
  time(@Param('id') id: string, @Body() dto: SdLogTimeDto, @Req() req: AuthedRequest): Promise<SdRequestDetail> {
    return this.requests.logTime(actorDesdeRequest(req), id, dto);
  }
}
