import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  RolesGuard, RequirePermissions, Permission, ReqUser,
  ScopeService, CANONICAL_PARAM, isPlatformAdminRole,
} from '@megadulces/platform-core';
import { BlindCountService } from './blind-count.service';
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
    const { kepler_enmascaro, kepler_contado, kepler_diff, esperado, diff_real, ...ciego } = r;
    return revela
      ? { ...ciego, esperado, diff_real, kepler_contado, kepler_diff, kepler_enmascaro }
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
    return {
      cash_cut_folio: turno.folio,
      caja: turno.caja,                 // la caja la dice Kepler, no el formulario
      caja_kepler: turno.caja,
      business_date: String(turno.business_date).slice(0, 10),
      turno: turno.turno || undefined,
      turno_abierto_at: turno.abierto_at || null,
    };
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
