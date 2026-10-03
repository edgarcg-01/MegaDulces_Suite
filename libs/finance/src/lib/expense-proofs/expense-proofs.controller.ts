import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission, isPlatformAdminRole } from '@megadulces/platform-core';
// `[GX.30]` La forma del borde HTTP, compartida con el frontend (ADR-052).
import type {
  ReaperturaDecidida, ReaperturaPendiente, SolicitudReaperturaCreada,
} from '@megadulces/contracts';
import { ExpenseProofsService, CreateExpenseProofDto, ListExpenseProofsQuery, type RespuestaPorAprobar, type RespuestaDelDia } from './expense-proofs.service';
// `[GX.49]` La forma de la solicitud que devuelve el lookup exacto.
import type { SolicitudKepler } from './expense-proofs.service';
// `[GX.41]` El vale que Kepler asigna por la caja «Solicita»: la forma vive en el contrato.
import type { ValeAsignado } from '@megadulces/contracts';
import type { CalendarioDelMes } from './calendario-gastos';

interface AuthedRequest { user?: { sub?: string; username?: string; full_name?: string; role_name?: string; permissions?: Record<string, boolean> }; }

/**
 * GX.7 — Solicitud de autorización de gastos (reembolso). Captura + adjuntos
 * (cualquiera con acceso a egresos) y validación/rechazo (gestión de finanzas).
 * No escribe a Kepler.
 */
@ApiTags('finance-expense-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/proofs')
export class ExpenseProofsController {
  constructor(private readonly svc: ExpenseProofsService) {}

  /**
   * El historial de gasto de TODA la empresa, sin acotar por persona.
   *
   * `[GX.26]` **Sólo god-mode**, por pedido del usuario (2026-09-25). Antes bastaba
   * `FINANCE_EXPENSES_VER` — 25 personas, de las cuales 9 eran cuentas de administración.
   *
   * ⛔ El recorte va **acá**, no sólo escondiendo la pestaña en la UI. Esta ruta devuelve
   * los expedientes de todos: si el candado viviera sólo en el front, cualquiera con `_VER`
   * la seguiría pudiendo pedir a mano y el «recorte» sería una decoración.
   *
   * ⚠️ El decorador de permiso NO alcanza para expresar «sólo god-mode»: `RolesGuard` deja
   * pasar a admin/superadmin **y** a quien tenga la clave, así que la clave sola abre la
   * puerta. Por eso el rol se comprueba explícito. Se conserva `_VER` como primer filtro:
   * quien no lo tiene se va antes, en el guard.
   *
   * ⚠️ Quien sólo captura NO pierde nada: `GET /mine` le sigue dando lo suyo, acotado por
   * su token.
   */
  @Get()
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: '[GX.26] Historial de gasto de toda la empresa + KPIs. SÓLO god-mode (admin/superadmin): devuelve los expedientes de todas las personas. Lo propio se pide por /mine.' })
  list(
    @Query('status') status?: string,
    @Query('folio_solicitud') folio_solicitud?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('dia') dia?: string,
    @Req() req?: AuthedRequest,
  ): ReturnType<ExpenseProofsService['list']> {
    if (!isPlatformAdminRole(req?.user?.role_name)) {
      throw new ForbiddenException('el historial de toda la empresa es sólo para administradores de la plataforma; lo tuyo está en /mine');
    }
    const q: ListExpenseProofsQuery = { status, folio_solicitud, search, from, to, dia, limit: limit ? Number(limit) : undefined };
    return this.svc.list(q);
  }

  @Get('departamentos')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Catálogo canónico de departamentos (dimensión dpto del ERP, deduplicada).' })
  departamentos() {
    return this.svc.departamentos();
  }

  @Get('search-solicitudes')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Busca la SOLICITUD (XA1501) contra la que se sube el comprobante. Folio por valor numérico (los últimos dígitos bastan) o beneficiario. Acotado a las áreas del usuario; sin áreas, sólo folio exacto.' })
  searchSolicitudes(@Query('q') q: string, @Query('limit') limit?: string, @Req() req?: AuthedRequest) {
    return this.svc.searchSolicitudes(q, limit ? Number(limit) : undefined, req?.user);
  }

  /**
   * `[GX.49]` Abrir UN vale concreto, desde «Subir evidencia». **No es el buscador**: pide
   * folio Y sucursal, devuelve a lo sumo una fila, y por eso puede saltarse el filtro de HOY
   * que el buscador sí aplica. Sin eso, un vale de ayer no se podía abrir.
   */
  @Get('solicitud-exacta')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[GX.49] La solicitud de Kepler por folio + sucursal exactos, de cualquier fecha. Para abrir un vale asignado, no para buscar.' })
  solicitudExacta(@Query('folio') folio: string, @Query('sucursal') sucursal: string, @Req() req?: AuthedRequest): Promise<SolicitudKepler[]> {
    return this.svc.solicitudExacta(folio, sucursal, req?.user);
  }

  @Get('mine')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Lo que capturó ESTE usuario. Ruta propia: abrir la bandeja completa a quien sólo captura le daría los comprobantes de toda la empresa.' })
  async mine(@Query('limit') limit?: string, @Query('search') search?: string, @Query('dia') dia?: string, @Req() req?: AuthedRequest):
    Promise<Awaited<ReturnType<ExpenseProofsService['list']>> & { asignados: ValeAsignado[] }> {
    const actor = req?.user?.full_name || req?.user?.username || '';
    // Sin actor NO se cae a sin-filtro: eso devolveria la bandeja completa de la
    // empresa a quien solo captura. Se devuelve vacio.
    // `[GX.39]` `etapas_de_la_pagina` vacio, no con ceros por etapa: cero vales no es
    // «cero por ejercer», es que no hay nada que contar.
    if (!actor) return { kpis: { total: 0, recibidas: 0, validadas: 0, rechazadas: 0, en_revision: 0 }, etapas_de_la_pagina: {}, abiertos_truncados: false, rows: [], asignados: [] };
    // [GX.25] `search` para que el historial propio tambien se pueda buscar. NO hay filtro
    // de fecha a proposito: el historial es de TODAS las fechas (pedido del usuario), a
    // diferencia del buscador de folios, que solo muestra las solicitudes de hoy.
    /**
     * `[GX.41]` Ademas de lo que capturo, **lo que Kepler le asigno por la caja «Solicita»**.
     * Va con el `username`, NO con `actor`: `actor` es `full_name || username` (lo que se le
     * muestra a una persona) y la caja de Kepler trae el usuario. Pasarle `actor` dejaria sin
     * vales a todo el que tenga nombre completo cargado, y en silencio.
     */
    const [propio, asignados] = await Promise.all([
      this.svc.list({ mine: actor, search, dia, limit: limit ? Number(limit) : undefined }),
      this.svc.valesAsignados(req?.user?.username),
    ]);
    return { ...propio, asignados };
  }

  @Get('resumen')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[GX.14] Resumen de lo que pidió ESTE usuario (12 meses o el mes en curso). Recortado por su alcance; sin alcance devuelve medido=false con el motivo, nunca ceros.' })
  resumen(@Query('periodo') periodo?: string, @Req() req?: AuthedRequest) {
    // Cualquier valor que no sea 'mes' cae en los 12 meses: un periodo inválido no debe
    // tumbar la pantalla, y 12m es el que contesta la pregunta «cómo vengo».
    return this.svc.resumenDelSolicitante(periodo === 'mes' ? 'mes' : '12m', req?.user);
  }

  @Get('por-aprobar')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[GX.17] Lo que espera luz verde, agrupado por fecha y por departamento. Mismo permiso que aprobar/validar/rechazar: quien no puede firmar tampoco necesita la bandeja.' })
  porAprobar(@Query('limit') limit?: string): Promise<RespuestaPorAprobar> {
    return this.svc.porAprobar(limit ? Number(limit) : undefined);
  }

  @Get('del-dia')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[GX.20] Los levantamientos de gasto de UN dia (captura, hora de Mexico), partidos en Aprobar / Ejercer / Todos. Sin `fecha` devuelve hoy. Trae el rail de dias con sus pendientes y lo que espera firma FUERA del dia: acotar por dia no puede esconder trabajo.' })
  delDia(@Query('fecha') fecha?: string, @Query('limit') limit?: string): Promise<RespuestaDelDia> {
    return this.svc.delDia(fecha, limit ? Number(limit) : undefined);
  }

  /**
   * `[GX.27]` El mes del historial: cuántos levantamientos hubo cada día y cuánto sumaron.
   *
   * ⚠️ El **alcance** lo decide esta ruta, no el cliente. `alcance=todos` es el calendario de
   * toda la empresa y por lo tanto **god-mode**, la misma regla que `[GX.26]` puso en la
   * colección: si acá se resolviera por un parámetro, el recorte de allá sería inútil —
   * bastaría pedir el calendario para saber cuánto gastó cada área.
   *
   * Cualquier otro valor cae en «lo mío», que es lo que todos pueden ver de sí mismos.
   */
  @Get('calendario')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[GX.27] Calendario del mes (YYYY-MM): por día, cuántos levantamientos y cuánto sumaron. `alcance=todos` es de toda la empresa y exige god-mode; cualquier otro valor devuelve lo del propio usuario.' })
  calendario(
    @Query('mes') mes?: string,
    @Query('alcance') alcance?: string,
    @Req() req?: AuthedRequest,
  ): Promise<CalendarioDelMes> {
    const esGod = isPlatformAdminRole(req?.user?.role_name);
    if (alcance === 'todos' && !esGod) {
      throw new ForbiddenException('el calendario de toda la empresa es sólo para administradores de la plataforma');
    }
    if (alcance === 'todos') return this.svc.calendarioMes(mes);
    const actor = req?.user?.full_name || req?.user?.username || '';
    // Sin actor NO se cae a sin-filtro: eso devolvería el calendario de la empresa entera a
    // quien sólo pidió el suyo. Se acota a un nombre que no existe → mes vacío, declarado.
    return this.svc.calendarioMes(mes, { mine: actor || '\u0000sin-actor' });
  }

  @Get('status-by-folio')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: '(C) Mapa folio_solicitud → estado, para el indicador en Solicitudes.' })
  statusByFolio() {
    return this.svc.statusByFolio();
  }

  @Get('proof-by-folio')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Estado del expediente de UN folio (para saber en qué momento está la captura). Accesible al capturista. `sucursal` desambigua: el folio de Kepler es único por plaza, no global.' })
  proofByFolio(@Query('folio') folio: string, @Query('sucursal') sucursal?: string) {
    return this.svc.proofByFolio(folio || '', sucursal);
  }

  // GX.9 — la bandeja de lo capturado en campo que todavía no se liga a un folio Kepler.
  // Va ANTES de ':id' o la ruta paramétrica se la traga (misma trampa que las de arriba).
  @Get('sin-folio')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Capturas de campo SIN casar (folio_solicitud IS NULL) + KPIs.' })
  sinFolio(@Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.sinFolio({ search, limit: limit ? Number(limit) : undefined });
  }

  /**
   * `[GX.59]` — **El Expediente: los vales de TODOS, agrupados por persona.**
   *
   * Pedido del usuario (2026-10-01): *«todos aquellos que tengan el poder de autorizar gastos
   * podrán ver los vales de todos»*.
   *
   * ## ⚠️ Esto ensancha a propósito lo que `[GX.26]` había cerrado
   * `GET /` (el historial de toda la empresa) quedó en **god-mode** el 2026-09-25, por pedido
   * del mismo usuario. Esta ruta **no lo toca**: es otra superficie, con otro permiso, y el
   * permiso elegido es el que ya tiene quien firma — `FINANCE_EXPENSES_COMPROBAR`, el mismo
   * que guarda `/finanzas/aprobacion-gastos`.
   *
   * **Medido antes de abrirla (local, 2026-10-01): 2 personas** (rol `tesoreria`) además de
   * los 12 de god-mode. ⛔ La medición es de la base LOCAL; prod no se alcanza desde acá, así
   * que el número de allá **está sin medir** y hay que verlo antes del redeploy.
   *
   * ⛔ El recorte vive en el guard, no en la pantalla: esta ruta devuelve el gasto de todas
   * las personas, y si el candado estuviera sólo en el front cualquiera la pediría a mano.
   */
  // Va ANTES de ':id' o la ruta paramétrica se la traga (misma trampa que las de arriba).
  @Get('expediente')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[GX.59] Expediente: los vales de todas las personas, agrupados por usuario (nombre + username), con el veredicto del protocolo. Para quien autoriza gastos.' })
  expediente(@Query('limit') limit?: string): ReturnType<ExpenseProofsService['expedientePorUsuario']> {
    return this.svc.expedientePorUsuario(limit ? Number(limit) : undefined);
  }

  // Va después de las rutas GET estáticas: declarada antes, ':id' se tragaría
  // 'departamentos', 'status-by-folio' y 'proof-by-folio'.
  @Get(':id')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Detalle de una solicitud con los adjuntos re-firmados (para el visor de quien revisa).' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }

  /**
   * `[GX.29]` El capturista PIDE que le reabran su vale ya aprobado, para agregar la
   * evidencia definitiva cuando el vale se aprobo con prefactura o cotizacion.
   *
   * ⚠️ Sin permiso especial: es su propio vale, y el servicio comprueba que lo sea. Gatearlo
   * con `_VER` dejaria afuera a los ~140 que solo capturan, que son justo quienes piden.
   */
  @Post(':id/reapertura')
  @ApiOperation({ summary: '[GX.29] Solicita reabrir un vale aprobado para agregar evidencia. Decide quien lo aprobo.' })
  solicitarReapertura(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req?: AuthedRequest): Promise<SolicitudReaperturaCreada> {
    const actor = req?.user?.full_name || req?.user?.username || '';
    return this.svc.solicitarReapertura(id, actor, body?.motivo || '');
  }

  /** `[GX.29]` Lo que ESTA persona tiene que decidir: solo los vales que ella aprobo. */
  @Get('reaperturas/pendientes')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[GX.29] Solicitudes de reapertura que le toca decidir a quien pregunta.' })
  reaperturasPendientes(@Req() req?: AuthedRequest): Promise<ReaperturaPendiente[]> {
    const actor = req?.user?.full_name || req?.user?.username || '';
    return this.svc.reaperturasPendientes(actor);
  }

  /** `[GX.29]` La decision. Solo quien aprobo el vale puede tomarla (lo valida el servicio). */
  @Post('reaperturas/:id/decidir')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[GX.29] Autoriza o niega una reapertura. Al autorizar, el vale vuelve a la bandeja del dia con vuelta+1.' })
  decidirReapertura(@Param('id') id: string, @Body() body: { aprueba?: boolean; nota?: string }, @Req() req?: AuthedRequest): Promise<ReaperturaDecidida> {
    const actor = req?.user?.full_name || req?.user?.username || '';
    return this.svc.decidirReapertura(id, actor, body?.aprueba === true, body?.nota);
  }

  @Post('upload')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Sube UN archivo (comprobante/solicitud/evidencia) al bucket y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string; live?: boolean; captured_at?: string }) {
    // [GX.14] `live` viaja con el archivo: es lo que después distingue una foto tomada en
    // el momento de un archivo cualquiera. Es una declaración del cliente, no una prueba
    // — el límite está escrito en `aporte-solicitante.contract.ts`, no escondido.
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || '', { live: body?.live === true, captured_at: body?.captured_at });
  }

  // `[GX.32]` Acá vivía `POST /validate-photo`, la vista previa del cuadre por visión.
  // Se retiró con la visión: su ÚNICA pantalla era la captura de gastos. ⚠️ El endpoint
  // homónimo de `expense-comprobaciones` es otro módulo y sigue en pie.

  @Post()
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Alta de la solicitud de reembolso (con los archivos ya subidos).' })
  create(@Body() body: CreateExpenseProofDto, @Req() req: AuthedRequest) {
    return this.svc.create(body, req?.user?.full_name || req?.user?.username);
  }

  // MOMENTO 3 — el capturista sube la evidencia DESPUÉS de aprobar (gasto comprobable).
  @Post(':id/evidence')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[GX.32] Sube la evidencia de un gasto ya APROBADO y comprobable. Queda en revision: la mira una persona.' })
  addEvidence(@Param('id') id: string, @Body() body: CreateExpenseProofDto, @Req() req: AuthedRequest) {
    return this.svc.addEvidence(id, body, req?.user?.full_name || req?.user?.username);
  }

  // MOMENTO 2 — el aprobador aprueba la solicitud capturada. Mismo permiso que validar.
  @Post(':id/approve')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Aprueba la solicitud capturada (con reclasificación opcional). Comprobable → aprobada (falta evidencia); no comprobable → validada. Auditado.' })
  approve(@Param('id') id: string,
    @Body() body: { clasificacion?: string; comprobacion_nota?: string;
                    provisional?: boolean; comprobante_esperado_at?: string },
    @Req() req: AuthedRequest): Promise<{ id: string; status: string }> {
    return this.svc.approve(id, req?.user?.full_name || req?.user?.username, body);
  }

  // Validar el gasto lo hace UNA persona (Tesorería). FINANCE_FINDINGS_GESTIONAR lo
  // tienen 27 usuarios porque cubre TODA la bandeja de hallazgos de finanzas; el permiso
  // del dominio es FINANCE_EXPENSES_COMPROBAR, que hoy tiene exactamente una.
  // admin/superadmin siguen pasando por el god-mode del RolesGuard.
  @Post(':id/validate')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Valida el expediente de gasto (con reclasificación opcional). Auditado.' })
  validate(@Param('id') id: string, @Body() body: { clasificacion?: string; comprobacion_nota?: string }, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username, body);
  }

  // GX.9 — ligar una captura de campo con su solicitud Kepler. Mismo permiso que aprobar:
  // decidir a qué folio pertenece un gasto es una decisión sobre el dinero, no captura.
  @Post(':id/match')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Casa una captura sin folio con su solicitud XA1501; re-corre el cuadre contra el importe de Kepler.' })
  match(@Param('id') id: string, @Body() body: { folio?: string }, @Req() req: AuthedRequest) {
    return this.svc.match(id, body?.folio || '', req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Rechaza la solicitud (con motivo). Auditado.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }
}
