import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission, RequireAnyPermission, RequirePermissions, RolesGuard, isPlatformAdminRole,
} from '@megadulces/platform-core';
import { HrAttendanceAgentService } from './attendance-agent.service';
import { HrAttendanceAlertsService } from './attendance-alerts.service';
import { HrAttendanceReportService } from './attendance-report.service';
import { HrAttendanceIncidentsService, type ActorIncidencia } from './attendance-incidents.service';
import { HrAttendanceClosuresService } from './attendance-closures.service';
import { HrAttendanceSchedulesService, type HorarioPersonaDto, type HorarioSitioDto } from './attendance-schedules.service';
import type { CapturaIncidencia } from './logic/incidencias';
import type { HrPersonaDirectorioDto } from '@megadulces/contracts';
import { RE_FECHA } from './logic/fechas';

/**
 * Fase RH · `[RH.1.5]`/`[RH.1.6]` — la API de asistencia: lo que las pantallas de `[RH.1.7]` van
 * a consumir. Todo bajo sesión de usuario (no `@Public`) y por clave exacta (ADR-054).
 *
 * Query params y campos de entrada en inglés snake_case (convención de la Suite). La asistencia
 * por persona responde con la forma de Mega Talento (ver `logic/asistencia-persona.ts`).
 *
 * Las claves se reparten con las pantallas; hasta entonces sólo las abre el administrador de
 * plataforma (god-mode por rol) y están declaradas en `SIN_REPARTIR` del candado de reparto.
 */

interface ReqUsuario {
  user?: { permissions?: Record<string, boolean>; roles_frescos?: string[]; role_name?: string };
}

/** Lo que el servicio de incidencias necesita saber del que pide, con los permisos FRESCOS. */
function actorDe(req: ReqUsuario): ActorIncidencia {
  const u = req?.user;
  const admin = (u?.roles_frescos?.length ? u.roles_frescos : [u?.role_name]).some((r) => isPlatformAdminRole(r));
  return {
    puedeCalificar: admin || u?.permissions?.[Permission.HR_INCIDENTS_CALIFICAR] === true,
    puedeAuditar: admin || u?.permissions?.[Permission.HR_INCIDENTS_AUDITAR] === true,
  };
}

/**
 * Leer incidencias y cierres: cualquier clave de RH. Quien sólo CIERRA la semana necesita ver las
 * incidencias (lo pendiente es lo que bloquea el cierre), y quien sólo captura necesita ver si la
 * semana ya se cerró (si no, su captura rebota con 409 sin que sepa por qué).
 */
const VER_INCIDENCIAS = [
  Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_INCIDENTS_CALIFICAR,
  Permission.HR_INCIDENTS_AUDITAR, Permission.HR_PERIOD_CLOSE,
];
/**
 * Leer la asistencia (y sus checadas, horarios y alertas): VER, o GESTIONAR — quien asigna horarios o decide
 * alertas no puede hacerlo sin ver a quién. Así el permiso de gestionar nunca aterriza en una pantalla que rebota.
 */
const VER_ASISTENCIA = [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR];
/** Los sitios de checado los necesita cualquier pantalla de RH (es el selector). */
const VER_ALGO_DE_RH = [...VER_INCIDENCIAS, Permission.HR_ATTENDANCE_GESTIONAR, Permission.HR_DEVICES_GESTIONAR];

@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/attendance')
export class HrAttendanceController {
  constructor(
    private readonly agent: HrAttendanceAgentService,
    private readonly alerts: HrAttendanceAlertsService,
    private readonly report: HrAttendanceReportService,
    private readonly incidents: HrAttendanceIncidentsService,
    private readonly closures: HrAttendanceClosuresService,
    private readonly schedules: HrAttendanceSchedulesService,
  ) {}

  // ── Sitios ───────────────────────────────────────────────────────────────────────────────

  @Get('sites')
  @RequireAnyPermission(...VER_ALGO_DE_RH)
  @ApiOperation({ summary: 'RH — los sitios de checado (el selector de todas las pantallas de RH).' })
  sitios() {
    return this.report.sitios();
  }

  // ── Asistencia y checadas ────────────────────────────────────────────────────────────────

  @Get('report')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — asistencia por persona de un sitio (horario deducido, bolsa semanal, faltas, horas).' })
  asistencia(@Query() q: { site_code?: string; date_from?: string; date_to?: string; only_promoters?: string }) {
    return this.report.asistencia({ ...q, only_promoters: q.only_promoters === '1' || q.only_promoters === 'true' });
  }

  @Get('people')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — el directorio de todas las plazas (para buscar a alguien sin saber dónde checa).' })
  directorio(): Promise<HrPersonaDirectorioDto[]> {
    return this.report.directorio();
  }

  @Get('punches')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — checadas crudas de un sitio y un rango.' })
  checadas(@Query() q: { site_code?: string; date_from?: string; date_to?: string; person_code?: string }) {
    return this.report.checadas(q);
  }

  @Get('punches/range')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — primer y último día con checadas de un sitio.' })
  rango(@Query('site_code') site: string) {
    return this.report.rango(site);
  }

  // ── Horarios ─────────────────────────────────────────────────────────────────────────────

  @Get('schedules')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — horarios del sitio.' })
  horarios(@Query('site_code') site: string) {
    return this.schedules.horariosDeSitio(site);
  }

  @Post('schedules')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — crear un horario del sitio.' })
  crearHorario(@Body() b: HorarioSitioDto) {
    return this.schedules.crearHorarioDeSitio(b);
  }

  @Put('schedules/:id')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — editar un horario del sitio.' })
  editarHorario(@Param('id') id: string, @Body() b: HorarioSitioDto) {
    return this.schedules.actualizarHorarioDeSitio(id, b);
  }

  @Post('schedules/:id/deactivate')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — desactivar un horario del sitio (no se borra).' })
  desactivarHorario(@Param('id') id: string) {
    return this.schedules.desactivarHorarioDeSitio(id);
  }

  @Put('person-schedules')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — ponerle su horario a una o varias personas del sitio (manda sobre la deducción).' })
  asignarHorario(@Body() b: HorarioPersonaDto) {
    return this.schedules.asignar(b);
  }

  @Post('person-schedules/remove')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — quitar el horario asignado: la persona vuelve al deducido.' })
  quitarHorario(@Body() b: { site_code?: string; person_codes?: unknown }) {
    return this.schedules.quitar(b);
  }

  // ── Agente de alertas ────────────────────────────────────────────────────────────────────

  @Get('agent/status')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — qué revisó el agente por su cuenta y cuándo, por sitio.' })
  estadoAgente() {
    return this.agent.estado();
  }

  @Post('agent/run-now')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — adelantar la revisión automática (ignora la huella).' })
  revisarAhora(@Body() b: { site_code?: string }) {
    return this.agent.revisarAhora(b?.site_code || undefined);
  }

  @Post('agent/analyze')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — analizar un rango arbitrario (historia profunda).' })
  analizar(@Body() b: { site_code?: string; date_from?: string; date_to?: string; include_ex_workers?: boolean }) {
    if (!b?.site_code || !RE_FECHA.test(String(b.date_from)) || !RE_FECHA.test(String(b.date_to))) {
      throw new BadRequestException('Faltan site_code, date_from y date_to (yyyy-MM-dd).');
    }
    if (String(b.date_to) < String(b.date_from)) throw new BadRequestException('date_to no puede ser anterior a date_from.');
    return this.agent.analizar({
      siteCode: b.site_code, desde: String(b.date_from), hasta: String(b.date_to), incluirExTrabajadores: b.include_ex_workers === true,
    });
  }

  // ── Alertas (RH decide) ──────────────────────────────────────────────────────────────────

  @Get('alerts')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — alertas del agente de un sitio.' })
  listarAlertas(@Query() q: { site_code: string; date_from?: string; date_to?: string; status?: string; person_code?: string }) {
    return this.alerts.listar(q);
  }

  @Get('alerts/grouped')
  @RequireAnyPermission(...VER_ASISTENCIA)
  @ApiOperation({ summary: 'RH — la cola agrupada por regla + sitio (+ persona).' })
  agrupar(@Query() q: { site_code?: string; date_from?: string; date_to?: string; status?: string; level?: string }) {
    return this.alerts.agrupar(q);
  }

  // Antes de `alerts/:id`: si no, 'group' se leería como un id.
  @Put('alerts/group')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — rechazar o descartar un GRUPO de alertas (aprobar es de una en una).' })
  decidirGrupo(@Body() b: { rule?: string; site_code?: string; person_code?: string; date_from?: string; date_to?: string; status?: string; justification?: string }) {
    return this.alerts.decidirGrupo(b);
  }

  @Put('alerts/:id')
  @RequirePermissions(Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — aprobar, rechazar o descartar una alerta.' })
  decidir(@Param('id') id: string, @Body() b: { status?: string; justification?: string }) {
    return this.alerts.decidir(id, String(b?.status || ''), b?.justification);
  }

  // ── Incidencias ──────────────────────────────────────────────────────────────────────────

  @Get('incidents/types')
  @RequireAnyPermission(...VER_INCIDENCIAS)
  @ApiOperation({ summary: 'RH — el catálogo de tipos de incidencia (para que la pantalla no lo copie).' })
  tipos() {
    return this.incidents.tipos();
  }

  @Get('incidents')
  @RequireAnyPermission(...VER_INCIDENCIAS)
  @ApiOperation({ summary: 'RH — incidencias que tocan un rango (statuses=todas incluye las anuladas).' })
  incidencias(@Query() q: { site_code?: string; date_from?: string; date_to?: string; person_code?: string; statuses?: string }) {
    return this.incidents.listar(q);
  }

  @Get('incidents/:id/log')
  @RequireAnyPermission(...VER_INCIDENCIAS)
  @ApiOperation({ summary: 'RH — cada paso de una incidencia.' })
  bitacora(@Param('id') id: string) {
    return this.incidents.bitacora(id);
  }

  @Post('incidents')
  @RequirePermissions(Permission.HR_INCIDENTS_CAPTURAR)
  @ApiOperation({ summary: 'RH — capturar una incidencia (quien califica la deja calificada, salvo deliver=true).' })
  capturar(@Body() b: CapturaIncidencia, @Req() req: ReqUsuario) {
    return this.incidents.capturar(b, actorDe(req));
  }

  @Post('incidents/:id/:action')
  @RequireAnyPermission(Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_INCIDENTS_CALIFICAR, Permission.HR_INCIDENTS_AUDITAR)
  @ApiOperation({ summary: 'RH — calificar, rechazar, anular o auditar una incidencia.' })
  paso(@Param('id') id: string, @Param('action') action: string, @Body() b: { reason?: string }, @Req() req: ReqUsuario) {
    return this.incidents.paso(id, action, String(b?.reason ?? '').trim(), actorDe(req));
  }

  // ── Cierre de semana ─────────────────────────────────────────────────────────────────────

  @Get('closures')
  @RequireAnyPermission(...VER_INCIDENCIAS)
  @ApiOperation({ summary: 'RH — cierres de un sitio (sin la foto).' })
  cierres(@Query('site_code') site: string) {
    return this.closures.listar(site);
  }

  // Antes de `closures/:id`.
  @Get('closures/status')
  @RequireAnyPermission(...VER_INCIDENCIAS)
  @ApiOperation({ summary: 'RH — semanas cerradas que toca un periodo.' })
  estadoCierre(@Query() q: { site_code?: string; date_from?: string; date_to?: string }) {
    return this.closures.estado(q);
  }

  @Get('closures/:id')
  @RequireAnyPermission(...VER_INCIDENCIAS)
  @ApiOperation({ summary: 'RH — un cierre con su foto.' })
  cierre(@Param('id') id: string) {
    return this.closures.uno(id);
  }

  @Post('closures')
  @RequirePermissions(Permission.HR_PERIOD_CLOSE)
  @ApiOperation({ summary: 'RH — cerrar la semana jueves→miércoles para prenómina.' })
  cerrar(@Body() b: { site_code?: string; period_start?: string }) {
    return this.closures.cerrar(b);
  }

  @Post('closures/:id/reopen')
  @RequirePermissions(Permission.HR_PERIOD_CLOSE)
  @ApiOperation({ summary: 'RH — reabrir una semana cerrada (exige motivo, no borra la foto).' })
  reabrir(@Param('id') id: string, @Body() b: { reason?: string }) {
    return this.closures.reabrir(id, String(b?.reason ?? ''));
  }
}
