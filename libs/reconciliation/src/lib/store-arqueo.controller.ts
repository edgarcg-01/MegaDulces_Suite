import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  RolesGuard, RequirePermissions, Permission, ReqUser,
  ScopeService, CANONICAL_PARAM, isPlatformAdminRole,
} from '@megadulces/platform-core';
import { BlindCountService } from './blind-count.service';
import { CashCutsSyncService } from './cash-cuts-sync.service';
import { CashCountSlaService } from './cash-count-sla.service';
import type { BlindCountDto } from './blind-count.service';

/**
 * SM.8/P1 — Superficie de arqueo ciego para CAJERAS (proyecto Tienda, /tienda/arqueo).
 *
 * Reusa `BlindCountService` (misma tabla `reconciliation.blind_counts` que el
 * Supervisor de Movimientos), pero acotada en los dos ejes:
 *
 *  - **QUÉ FILAS** (`[ID.4]`, ADR-050): el alcance sale de `ScopeService`, no del
 *    viejo `user?.warehouse_code || query.warehouse_code` (fail-OPEN: quien no
 *    tenía sucursal asignada veía la red completa). Ahora la cajera ve y captura
 *    exactamente las sucursales que tiene asignadas — una, varias (`listed`) o
 *    ninguna. Escribir en otra es 403 explícito, no un filtro que se puede saltar.
 *
 *  - **QUÉ CAMPOS**: la cajera **no ve el esperado ni su diferencia**. Contar a
 *    ciegas y después ver el hueco es lo mismo que saber el esperado (esperado =
 *    contado + diferencia): con eso puede "ajustar" el conteo en una recaptura, o
 *    saber cuánto puede faltar sin que se note. Solo el supervisor
 *    (`RECONCILIATION_VER`, /almacen/cuadre) revela — y ahí ya se ve además el
 *    flag de enmascaramiento de Kepler. El descuadre igual se levanta al instante
 *    en la bandeja del supervisor (autolineado SM.9): la cajera no lo ve, pero pasa.
 */
type AuthUser = {
  username?: string;
  warehouse_code?: string;
  role_name?: string;
  permissions?: Record<string, boolean>;
} | undefined;

const WH = CANONICAL_PARAM.warehouse; // 'warehouse_codes'

@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/arqueo')
export class StoreArqueoController {
  constructor(
    private readonly blind: BlindCountService,
    private readonly sync: CashCutsSyncService,
    private readonly sla: CashCountSlaService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * ¿Este usuario puede ver el esperado? Solo el supervisor del motor de cuadre
   * (o un admin de plataforma). Todo lo demás es "cajera" a estos efectos: se le
   * devuelve SU conteo y nada más.
   */
  private revela(user: AuthUser): boolean {
    return isPlatformAdminRole(user?.role_name)
      || user?.permissions?.[Permission.RECONCILIATION_VER] === true;
  }

  /**
   * Quita todo lo que permita deducir el esperado. `diff_real` se va junto con
   * `esperado` a propósito: publicar uno de los dos es publicar los dos.
   *
   * A quien valida se le devuelve TODO, incluido el arqueo que declaró Kepler
   * (`kepler_contado`): la comparación entre ese número y el nuestro es
   * literalmente el trabajo de la encargada — los dos dicen haber contado el
   * mismo cajón y casi nunca coinciden.
   */
  private proyectar<T extends Record<string, any>>(r: T, revela: boolean) {
    // El desglose de Kepler se recorta con el resto: sus billetes y monedas suman
    // el contado declarado, así que publicarlos es publicar el esperado en dos
    // partes. Van en la MISMA lista que `esperado` a propósito.
    const { kepler_enmascaro, kepler_contado, kepler_diff, esperado, diff_real,
            kepler_billetes, kepler_monedas, kepler_retirado, ...ciego } = r;
    return revela
      ? { ...ciego, esperado, diff_real, kepler_contado, kepler_diff, kepler_enmascaro,
          kepler_billetes, kepler_monedas, kepler_retirado }
      : ciego;
  }

  /**
   * Sucursal sobre la que se captura: la pedida (validada contra el alcance de
   * ESCRITURA) o, si no se pidió, la suya cuando tiene exactamente una. Con
   * varias asignadas hay que elegir — adivinar sería sellar dinero en la caja
   * equivocada.
   */
  private async resolverSucursal(pedida: string | undefined): Promise<string> {
    const code = (pedida || '').trim();
    if (code) {
      await this.scope.assertCanWrite('warehouse', code);
      return code;
    }
    const dim = (await this.scope.current()).dims.warehouse;
    if (dim.modeWrite !== 'all' && dim.valuesWrite.length === 1) return dim.valuesWrite[0];
    throw new BadRequestException(
      dim.valuesWrite.length > 1
        ? `Elegí la sucursal: tenés ${dim.valuesWrite.length} asignadas (${dim.valuesWrite.join(', ')}).`
        : 'Tu usuario no tiene sucursal asignada para capturar arqueos. Pedile al administrador que te asigne una.',
    );
  }

  /**
   * A nombre de QUIÉN queda el arqueo.
   *
   * El `username` **es** el código de cajero de Kepler: verificado contra
   * `analytics.cash_cuts`, `upper(username) = upper(cajero_cierre)` liga a cada
   * cajera con sus cortes (`10c02`→48, `42dmar`→204, `54tysl`→120…). Va en
   * MAYÚSCULAS porque así lo guarda el ERP, y es la llave con la que
   * `BlindCountService.compare()` encuentra el turno.
   *
   * A la cajera se le **impone** su propio usuario: firmar un conteo de efectivo
   * a nombre de otra persona no es un campo de formulario. El supervisor sí puede
   * capturar por alguien (arqueo de relevo, cajera sin acceso), y si no dice nada
   * queda a su nombre.
   */
  private atribuir(body: BlindCountDto, user: AuthUser, revela: boolean): string | undefined {
    const propio = user?.username?.trim().toUpperCase() || undefined;
    if (!revela) return propio;
    return body?.cajero_code?.trim().toUpperCase() || propio;
  }

  @Get('turnos')
  @RequirePermissions(Permission.STORE_ARQUEO_CAPTURAR)
  @ApiOperation({ summary: 'Tienda — turnos de caja que Kepler abrió a tu nombre y todavía no arqueaste. Es lo que habilita la captura (sin turno no hay arqueo).' })
  @ApiQuery({ name: 'dias', required: false, description: 'Ventana hacia atrás (default 2, máx 30).' })
  async turnos(@ReqUser() user: AuthUser, @Query('dias') dias?: string) {
    const scope = (await this.scope.current()).dims.warehouse;
    return this.blind.turnosPendientes({
      cajeroCode: user?.username,
      warehouseCodes: scope.mode === 'all' ? null : scope.values,
      dias: dias ? Number(dias) : undefined,
    });
  }

  /**
   * Kepler manda: la caja, la fecha y la hora salen del turno, no del formulario.
   *
   * Kepler ya sabe qué caja le tocó a quién y desde qué hora (abre el renglón con
   * `caja`, `cajera asignada` y `hora de apertura`). Dejar que la cajera teclee la
   * caja es abrir la puerta a arquear la caja de otra, o un turno que no existió.
   * Para la cajera el turno es **obligatorio** y sus datos **mandan** sobre el body.
   * El supervisor puede capturar sin turno (relevo, contingencia, caja sin Kepler).
   */
  private async anclarAlTurno(body: BlindCountDto, warehouse_code: string, cajero_code: string | undefined, revela: boolean) {
    const folio = body?.cash_cut_folio ? String(body.cash_cut_folio).trim() : '';
    if (!folio) {
      if (revela) return {}; // supervisor: puede capturar a mano
      throw new BadRequestException(
        'Elegí el turno de caja que vas a arquear. Si no aparece ninguno es que Kepler todavía no abrió tu caja.',
      );
    }
    const turno = await this.blind.buscarTurno(warehouse_code, folio, revela ? undefined : cajero_code);
    if (!turno) {
      throw new BadRequestException(
        revela
          ? `No existe el turno ${folio} en la sucursal ${warehouse_code}.`
          : 'Ese turno no es tuyo o ya no existe en Kepler.',
      );
    }
    await this.exigirElMasViejo(body, folio, revela, cajero_code, warehouse_code);
    return {
      cash_cut_folio: turno.folio,
      caja: turno.caja,                 // la caja la dice Kepler, no el formulario
      caja_kepler: turno.caja,
      business_date: String(turno.business_date).slice(0, 10),
      turno: turno.turno || undefined,
      turno_abierto_at: turno.abierto_at || null,
    };
  }

  /**
   * SM.16 — Los cortes se cierran EN ORDEN. Con un turno pendiente de ayer no se
   * puede arquear el de hoy.
   *
   * El turno sin arquear es donde se esconde el hueco: si se puede elegir cuál
   * contar, se cuenta el que conviene y el otro se deja envejecer hasta que a
   * nadie le importe. Además el conteo se vuelve inauditable — el efectivo de dos
   * turnos se mezcla en el mismo cajón y ya no se sabe de cuál falta.
   *
   * Va en el BACKEND y no solo en la pantalla: la lista es una ayuda, la regla es
   * esto. Mandar el folio de hoy a mano no la salta.
   *
   * Solo aplica al **cierre**. El relevo es intra-turno y urgente (la cajera está
   * entregando la caja ahora); bloquearlo porque quedó un cierre viejo pendiente
   * pararía el mostrador sin proteger nada — el control del dinero es el cierre.
   * Y el supervisor queda exento: captura por otros y en contingencia.
   */
  private async exigirElMasViejo(body: BlindCountDto, folio: string, revela: boolean, cajero_code: string | undefined, warehouseCode: string) {
    if (revela) return;
    if ((body?.tipo ?? 'cierre') !== 'cierre') return;
    // Corregir un conteo YA hecho no es saltarse la fila: el turno viejo sigue
    // igual de pendiente después de la corrección, así que bloquearla no protege
    // nada — y sí deja congelada una cifra que la cajera sabe equivocada, que es
    // justo lo contrario de lo que esta regla busca.
    // La sucursal RESUELTA, no `body.warehouse_code`: la cajera no lo manda, así
    // que leerlo del body dejaría el chequeo en un no-op silencioso.
    if (await this.blind.yaArqueado(warehouseCode, folio)) return;
    const scope = (await this.scope.current()).dims.warehouse;
    const pendientes = await this.blind.turnosPendientes({
      cajeroCode: cajero_code,
      warehouseCodes: scope.mode === 'all' ? null : scope.values,
    });
    const primero = pendientes[0];               // viene ordenada del más viejo
    if (!primero || primero.folio === folio) return;
    const cuando = new Date(`${primero.business_date}T12:00:00`)
      .toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' });
    throw new BadRequestException(
      `Tenés un corte pendiente antes que ese: caja ${primero.caja} del ${cuando}. ` +
      'Cerrá ese primero — los arqueos se hacen en orden.',
    );
  }

  @Post()
  @RequirePermissions(Permission.STORE_ARQUEO_CAPTURAR)
  @ApiOperation({ summary: 'Tienda — la cajera arquea el TURNO que Kepler le abrió. Queda a nombre de su usuario y devuelve solo su total contado (el esperado y la diferencia son del supervisor).' })
  async submit(@Body() body: BlindCountDto, @ReqUser() user: AuthUser) {
    const revela = this.revela(user);
    const warehouse_code = await this.resolverSucursal(body?.warehouse_code);
    const cajero_code = this.atribuir(body, user, revela);
    const delTurno = await this.anclarAlTurno(body, warehouse_code, cajero_code, revela);
    const res = await this.blind.submit({ ...body, warehouse_code, cajero_code, ...delTurno }, user?.username);
    // Sin revelación, `matched`/`ambiguous` tampoco tienen sentido (no hay nada
    // que comparar del lado de la cajera) y `ambiguous` filtraría que hay más de
    // un corte en su caja. Respuesta mínima: se guardó y cuánto contó.
    return revela
      ? { ...this.proyectar(res, true), reveal: true }
      : { tipo: res.tipo, total_contado: res.total_contado, reveal: false };
  }

  @Get()
  @RequirePermissions(Permission.STORE_ARQUEO_VER)
  @ApiQuery({ name: WH, required: false, description: 'Sucursal o CSV de sucursales. Se recorta a tu alcance. Acepta los nombres viejos (warehouse_code, sucursal…) y valores en código o uuid.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Tienda — historial de arqueos. La cajera ve SOLO los suyos; la encargada, los de sus sucursales (con esperado, diferencia y el botón de validar).' })
  async list(@ReqUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    const revela = this.revela(user);
    const warehouse_codes = await this.scope.readParam(query, 'warehouse', 'store/arqueo');
    const limit = query['limit'];
    const rows = await this.blind.list({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      warehouse_codes,
      // La encargada supervisa la tienda entera (todas las cajas); la cajera ve
      // SOLO lo suyo. Filtrar solo por sucursal le mostraría el conteo de sus
      // compañeras — y con eso, cuánto entregó cada una.
      cajero_code: revela ? undefined : (user?.username || ' '),
      limit: limit ? Number(limit) : undefined,
    });
    return rows.map((r) => this.proyectar(r, revela));
  }

  /**
   * SM.14 — Historial de arqueos: detalle + acumulado por cajera.
   *
   * Mismo recorte que el listado: la cajera ve solo los suyos (y el "por cajera"
   * le queda con una sola fila, la propia), la encargada ve los de sus sucursales
   * con el esperado, la diferencia y quién validó cada uno.
   */
  @Get('historial')
  @RequirePermissions(Permission.STORE_ARQUEO_VER)
  @ApiQuery({ name: WH, required: false, description: 'Sucursal o CSV. Se recorta a tu alcance.' })
  @ApiQuery({ name: 'from', required: false, description: "Desde (ISO 'YYYY-MM-DD')." })
  @ApiQuery({ name: 'to', required: false, description: "Hasta (ISO 'YYYY-MM-DD')." })
  @ApiQuery({ name: 'cajero', required: false, description: 'Código de cajera. Ignorado si sos cajera (siempre vos).' })
  @ApiQuery({ name: 'sin_validar', required: false, description: '`true` = solo los que faltan firmar.' })
  @ApiOperation({ summary: 'Tienda — historial de arqueos por cajera, con quién lo capturó y quién lo validó.' })
  async historial(@ReqUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    const revela = this.revela(user);
    const warehouse_codes = await this.scope.readParam(query, 'warehouse', 'store/arqueo/historial');
    const limit = query['limit'];
    const res = await this.blind.historial({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      warehouse_codes,
      // A la cajera se le fuerza el suyo; la encargada puede filtrar por una.
      cajero_code: revela ? ((query['cajero'] as string) || undefined) : (user?.username || ' '),
      solo_sin_validar: String(query['sin_validar'] ?? '') === 'true',
      limit: limit ? Number(limit) : undefined,
    });
    const arqueos = res.arqueos.map((r: any) => this.proyectar(r, revela));
    if (revela) return { ...res, arqueos };
    // El AGREGADO también revela: `faltante_total` sobre un solo arqueo ES la
    // diferencia de ese arqueo, y de ahí sale el esperado. `proyectar()` limpia
    // las filas pero no el resumen — hay que recortarlo aparte.
    return {
      arqueos,
      por_cajera: res.por_cajera.map((g: any) => ({
        cajero_code: g.cajero_code, cajero_nombre: g.cajero_nombre, warehouse_code: g.warehouse_code,
        arqueos: g.arqueos, total_contado: g.total_contado,
        sin_validar: g.sin_validar, ultima_fecha: g.ultima_fecha,
      })),
      totales: { arqueos: res.totales.arqueos, sin_validar: res.totales.sin_validar },
    };
  }

  /**
   * SM.21 — Cumplimiento del arqueo: qué % de los cortes llegó a tener conteo
   * físico, cuánto tardó y cuánto dinero quedó sin verificar.
   *
   * Solo para quien supervisa. A la cajera no le sirve y además son montos: es la
   * misma línea que separa `revela` en todo este controlador.
   */
  @Get('cumplimiento')
  @RequirePermissions(Permission.STORE_ARQUEO_VER)
  @ApiQuery({ name: WH, required: false, description: 'Sucursal o CSV. Se recorta a tu alcance.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiOperation({ summary: 'Tienda — cumplimiento del arqueo por sucursal (cortes contados, demora, monto sin verificar).' })
  async cumplimiento(@ReqUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    if (!this.revela(user)) throw new ForbiddenException('El cumplimiento del arqueo es del supervisor.');
    const warehouse_codes = await this.scope.readParam(query, 'warehouse', 'store/arqueo/cumplimiento');
    await this.sync.syncCurrentTenant();
    const filas = await this.sla.cumplimiento({ desde: query['from'] as string | undefined, warehouseCodes: warehouse_codes });
    const t = filas.reduce((a, f) => ({
      cortes: a.cortes + f.cortes, arqueados: a.arqueados + f.arqueados,
      pendientes: a.pendientes + f.pendientes, no_verificables: a.no_verificables + f.no_verificables,
      monto_sin_verificar: a.monto_sin_verificar + Number(f.monto_sin_verificar || 0),
    }), { cortes: 0, arqueados: 0, pendientes: 0, no_verificables: 0, monto_sin_verificar: 0 });
    return {
      sucursales: filas,
      totales: { ...t, pct: t.cortes ? Math.round((t.arqueados / t.cortes) * 1000) / 10 : 0 },
      sla_min: CashCountSlaService.SLA_MIN,
      critico_min: CashCountSlaService.CRITICO_MIN,
    };
  }

  /**
   * SM.21 — Dispara el barrido de plazos a mano. El cron corre cada 15 min; esto
   * existe para no esperarlo al operar (y para el smoke). Idempotente: el hallazgo
   * se hace UPSERT por `dedup_key`.
   */
  @Post('scan-sla')
  @RequirePermissions(Permission.STORE_ARQUEO_VER)
  @ApiOperation({ summary: 'Tienda — barre ahora los cortes sin conteo fuera de plazo y los manda a la bandeja.' })
  async scanSla(@ReqUser() user: AuthUser) {
    if (!this.revela(user)) throw new ForbiddenException('El barrido de plazos es del supervisor.');
    await this.sync.syncCurrentTenant();
    return this.sla.scanCurrentTenant();
  }

  /**
   * SM.19 — Historial por PERSONA: una tarjeta por cajera con todos sus cortes.
   *
   * A diferencia de `/historial`, parte de los cortes de Kepler, así que también
   * muestra los turnos que **nadie arqueó** — que son los que hay que perseguir.
   *
   * Mismo recorte: la cajera se ve solo a sí misma y sin nada del cuadre; a ella
   * se le quitan hasta los acumulados, porque un faltante sobre un solo corte ES
   * la diferencia de ese corte.
   */
  @Get('por-cajera')
  @RequirePermissions(Permission.STORE_ARQUEO_VER)
  @ApiQuery({ name: WH, required: false, description: 'Sucursal o CSV. Se recorta a tu alcance.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiOperation({ summary: 'Tienda — tarjetas por cajera: sus cortes de Kepler con horarios, y el arqueo nuestro cuando existe.' })
  async porCajera(@ReqUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    const revela = this.revela(user);
    const warehouse_codes = await this.scope.readParam(query, 'warehouse', 'store/arqueo/por-cajera');
    // Kepler genera el corte solo: antes de pintar, lo jalamos. Es un UPSERT de
    // una sentencia sobre 3 días (~60 filas) en la misma base, así que cuesta
    // milisegundos y garantiza que ningún turno cerrado se vea como inexistente
    // aunque el cron todavía no haya corrido. Best-effort a propósito: si el ODS
    // está caído, la pantalla muestra lo que ya teníamos en vez de romperse.
    await this.sync.syncCurrentTenant();
    const res = await this.blind.porCajera({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      warehouse_codes,
      cajero_code: revela ? ((query['cajero'] as string) || undefined) : (user?.username || ' '),
      limit: query['limit'] ? Number(query['limit']) : undefined,
    });
    if (revela) return res;
    return {
      cajeras: res.cajeras.map((g: any) => ({
        cajero_code: g.cajero_code, cajero_nombre: g.cajero_nombre,
        warehouse_code: g.warehouse_code, warehouse_name: g.warehouse_name,
        cortes: g.cortes, dias: g.dias, sin_arqueo: g.sin_arqueo, ultimo: g.ultimo,
        turnos: g.turnos.map((t: any) => ({
          arqueo_id: t.arqueo_id, business_date: t.business_date, caja: t.caja, folio: t.folio,
          hora_apertura: t.hora_apertura, hora_cierre: t.hora_cierre, duracion_horas: t.duracion_horas,
          nuestro_contado: t.nuestro_contado, denominaciones: t.denominaciones,
          capturado_por: t.capturado_por, capturado_at: t.capturado_at,
          validado_por: t.validado_por, validado_at: t.validado_at,
        })),
      })),
      totales: { cajeras: res.totales.cajeras, cortes: res.totales.cortes, sin_arqueo: res.totales.sin_arqueo },
    };
  }

  /**
   * SM.12 — La encargada va al lugar, cuenta con la cajera y firma.
   *
   * Gateado por `RECONCILIATION_VER`, que es lo que separa a la encargada de la
   * cajera (`encargado_tienda` lo tiene, `cajero` no): validar tu propio arqueo
   * sería firmarte a vos mismo. Recapturar el conteo **borra la firma** — un
   * arqueo distinto es un arqueo sin validar (ver `submit`).
   */
  @Post(':id/validar')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Tienda — la encargada valida presencialmente el arqueo de la cajera (queda firmado con su usuario y la hora).' })
  async validar(@Param('id', new ParseUUIDPipe()) id: string, @ReqUser() user: AuthUser, @Body() body?: { nota?: string }) {
    return this.blind.validar(id, user?.username, body?.nota);
  }
}
