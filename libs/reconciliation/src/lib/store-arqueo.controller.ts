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
 *    (`RECONCILIATION_VER`, /finanzas/cuadre) revela — y ahí ya se ve además el
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
        ? `Elige la sucursal: tienes ${dim.valuesWrite.length} asignadas (${dim.valuesWrite.join(', ')}).`
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
  @ApiOperation({ summary: 'Tienda — turnos de caja que Kepler abrió a tu nombre y todavía no arqueaste. Es la lista de qué contar; desde SM.40 NO es un requisito para capturar.' })
  @ApiQuery({ name: 'dias', required: false, description: 'Ventana hacia atrás, en días. Misma para cajera y supervisor (default 7, tope 30).' })
  async turnos(@ReqUser() user: AuthUser, @Query('dias') dias?: string) {
    const scope = (await this.scope.current()).dims.warehouse;
    // SM.40 — la ventana es la misma para todos y se puede ampliar. El tope vive
    // en el SERVICIO, no acá, así que mandar `?dias=999` a mano tampoco la estira.
    const cajero = user?.username;
    /**
     * SM.38/SM.40 - El aviso viaja con la lista, no en una llamada aparte: si la
     * pantalla tuviera que preguntarlo por separado, un error de red la dejaria
     * mostrando los turnos sin el aviso.
     *
     * ⚠️ SM.40 - Antes, con dos cajas abiertas, esto devolvia `turnos: []` y la
     * captura desaparecia entera. Ahora los turnos van SIEMPRE y el aviso los
     * acompana: la senal se dice, la persona decide. Es el mismo cambio que en
     * `submit()`, y por el mismo motivo -- el unico modo de "desbloquearse" era
     * que llegara un dato del ODS, asi que una caida de la ingesta paraba el
     * mostrador (medido 2026-09-29).
     */
    const aviso = cajero ? await this.blind.avisoDobleCaja(cajero) : null;
    const turnos = await this.blind.turnosPendientes({
      cajeroCode: cajero,
      warehouseCodes: scope.mode === 'all' ? null : scope.values,
      dias: dias ? Number(dias) : undefined,
      revela: this.revela(user),
    });
    return { turnos, aviso };
  }

  /**
   * Kepler manda: la caja, la fecha y la hora salen del turno, no del formulario.
   *
   * Kepler ya sabe qué caja le tocó a quién y desde qué hora (abre el renglón con
   * `caja`, `cajera asignada` y `hora de apertura`), así que **cuando hay turno sus
   * datos MANDAN sobre el body**: la caja no se elige, es la que te tocó.
   *
   * ⚠️ SM.40 - Lo que cambia es el caso SIN turno. Antes era un 400 para la
   * cajera ("elige el turno… si no aparece ninguno es que Kepler todavía no abrió
   * tu caja") y eso convertía cualquier atraso del ERP o de la ingesta en un
   * mostrador parado: medido el 2026-09-29, con `kdpv_folio_caja` sin una sola
   * fila del 24 al 29, ninguna de las 25 cajeras con turno colgado podía registrar
   * su conteo. Ahora captura igual, declarando la caja, y el arqueo queda **sin
   * folio** — o sea `matched: false`, sin comparación contra Kepler y visible como
   * tal. Un conteo que no cuadra vale muchísimo más que ningún conteo: el dinero
   * se contó y quedó firmado con hora y persona.
   */
  private async anclarAlTurno(body: BlindCountDto, warehouse_code: string, cajero_code: string | undefined, revela: boolean) {
    const folio = body?.cash_cut_folio ? String(body.cash_cut_folio).trim() : '';
    // Sin folio se captura a mano — supervisor y cajera por igual (SM.40).
    if (!folio) return {};
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

  /**
   * ⚠️ SM.40 — Acá vivía `exigirElMasViejo()` (SM.16): "los cortes se cierran EN
   * ORDEN, con un turno pendiente de ayer no se puede arquear el de hoy".
   *
   * Se retira por decisión de Edgar (2026-09-29) y con la medición encima. El
   * argumento original era bueno —un turno sin arquear es donde se esconde el
   * hueco— pero la regla se apoyaba en una premisa falsa: que el turno viejo se
   * puede cerrar. En la operación real no siempre: `turnosPendientes` deja entrar
   * SIEMPRE los turnos abiertos sin importar la fecha (la excepción de SM.37, para
   * que la caja que cruza la medianoche no desaparezca), así que un turno que
   * nadie va a cerrar quedaba clavado en el primer lugar de la fila y bloqueaba
   * para siempre el cierre de hoy. Medido en prod: 4 cajeras activas trabadas
   * —`40VMC` desde el 31 de enero, 235 días— y su única salida era capturar un
   * conteo falso del turno viejo. Una regla anti-fraude cuya única escapatoria es
   * un dato inventado trabaja en contra de lo que quiere proteger.
   *
   * Lo que la reemplaza NO es nada: es el aviso de apertura (`avisarAperturas`) y
   * el tablero de cumplimiento, que ya miden qué se contó y qué no **sin impedir
   * que alguien cuente**.
   */

  /**
   * SM.36 - Las rutas que ESTA tienda puede arquear.
   *
   * Se resuelve con la sucursal del usuario, no con un parametro: el pedido fue
   * que la encargada de Padre Hidalgo vea las rutas de Padre Hidalgo y nada mas.
   * Devolver [] es respuesta valida (hay tiendas sin rutas dadas de alta).
   */
  @Get('rutas')
  @RequirePermissions(Permission.STORE_ARQUEO_RUTA_CAPTURAR)
  @ApiOperation({ summary: 'Tienda - rutas RD/RV dadas de alta en tu sucursal, para el arqueo de la entrega del vendedor.' })
  async rutas(@Query() query: Record<string, unknown>) {
    const warehouse_code = await this.resolverSucursal((query?.['warehouse_code'] as string) || undefined);
    const rutas = await this.blind.rutasDeSucursal(warehouse_code);
    return {
      warehouse_code,
      rd: rutas.filter((r) => r.tipo === 'rd'),
      rv: rutas.filter((r) => r.tipo === 'rv'),
    };
  }

  /**
   * SM.36 - El vendedor de ruta entrega su efectivo y la encargada lo cuenta.
   *
   * Endpoint APARTE del `POST /` a proposito, y esa es la decision de seguridad
   * de esta entrega: `POST /` esta gateado con `STORE_ARQUEO_CAPTURAR`, que en
   * prod tienen tambien `cajero` y `piso_tienda`. Si el arqueo de ruta fuera un
   * `tipo` mas del mismo endpoint, cualquier cajera podria sellar la entrega de
   * una ruta mandando `tipo: "rd"` - la puerta nueva seria decorativa.
   *
   * Tampoco pasa por `anclarAlTurno()`: una ruta no tiene turno de caja en
   * Kepler. Por eso `caja` lleva el literal RD/RV (la estacion) y la identidad
   * la da `route_code`.
   *
   * ⚠️ NO devuelve diferencia: el esperado de una ruta no existe hoy (medido).
   * Se responde lo contado y se DECLARA el motivo, en vez de dibujar un cero
   * que se leeria como "cuadro" (ADR-056).
   */
  @Post('ruta')
  @RequirePermissions(Permission.STORE_ARQUEO_RUTA_CAPTURAR)
  @ApiOperation({ summary: 'Tienda - arqueo de la entrega del vendedor de ruta (RD/RV). Sin esperado: registra custodia, no diferencia.' })
  async submitRuta(@Body() body: BlindCountDto, @ReqUser() user: AuthUser) {
    const tipo = body?.tipo;
    if (tipo !== 'rd' && tipo !== 'rv') {
      throw new BadRequestException('tipo debe ser "rd" (ruta de reparto) o "rv" (ruta vecinal).');
    }
    const warehouse_code = await this.resolverSucursal(body?.warehouse_code);
    const route_code = (body?.route_code || '').trim();

    // La ruta tiene que estar dada de alta en SU tienda. Sin esta validacion, el
    // alcance seria una sugerencia del frontend: bastaria mandar otra clave.
    const permitidas = await this.blind.rutasDeSucursal(warehouse_code);
    const ruta = permitidas.find((r) => r.route_code === route_code);
    if (!ruta) {
      throw new BadRequestException(
        permitidas.length
          ? `La ruta ${route_code || '(vacia)'} no esta dada de alta en la sucursal ${warehouse_code}.`
          : `La sucursal ${warehouse_code} no tiene rutas dadas de alta. Pedile al administrador que las asigne.`,
      );
    }
    if (ruta.tipo !== tipo) {
      throw new BadRequestException(`La ruta ${route_code} es de tipo ${ruta.tipo}, no ${tipo}.`);
    }

    const res = await this.blind.submit(
      {
        ...body,
        warehouse_code,
        route_code,
        // Una ruta no es una caja: `caja` lleva la estacion, la ruta va aparte.
        caja: tipo.toUpperCase(),
        cash_cut_folio: undefined,
        caja_kepler: undefined,
        turno_abierto_at: null,
      },
      user?.username,
    );
    return {
      tipo: res.tipo,
      total_contado: res.total_contado,
      route_code,
      route_label: ruta.label,
      // Se DECLARA en la respuesta: la pantalla no tiene que inferirlo.
      medible: false,
      motivo_no_medible: 'sin_esperado',
    };
  }

  @Post()
  @RequirePermissions(Permission.STORE_ARQUEO_CAPTURAR)
  @ApiOperation({ summary: 'Tienda — la cajera arquea el TURNO que Kepler le abrió (o captura a mano si todavía no hay turno). Queda a nombre de su usuario y devuelve solo su total contado.' })
  async submit(@Body() body: BlindCountDto, @ReqUser() user: AuthUser) {
    const revela = this.revela(user);
    const warehouse_code = await this.resolverSucursal(body?.warehouse_code);
    const cajero_code = this.atribuir(body, user, revela);
    // SM.40 — sin candados: ni orden de cortes, ni una sola caja abierta, ni
    // ventana del día. Lo que queda es la identidad (a tu nombre), el alcance (tu
    // sucursal) y el turno cuando existe. Ver el bloque de arriba.
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
      // El fallback era un byte NUL literal (typo: los otros dos usan ' ').
      // Postgres NO admite NUL en text: `upper(cajero_code) = <NUL>` tira
      // 22021 y el endpoint devolvia 500 en vez de una lista vacia. El
      // espacio es el centinela que no casa con nada — falla cerrado.
      cajero_code: revela ? undefined : (user?.username || ' '),
      // SM.33 — Y solo los de HOY. La encargada necesita el historial para
      // perseguir descuadres viejos; la cajera no tiene nada que hacer con
      // el suyo, y tenerlo a la vista invita a "ajustar" el conteo para que
      // se parezca al de ayer. Va aca y no en la pantalla: los query params
      // se editan y la URL se teclea.
      solo_hoy: !revela,
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
      // SM.33 — mismo recorte que el listado: sin supervision, solo el dia.
      solo_hoy: !revela,
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
    };
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
    // SM.33 — Esta vista ES un historial: el acumulado de cortes por cajera.
    // No se le recorta al dia, se le NIEGA — a quien no supervisa no le sirve
    // ni su propia fila. Misma linea que `cumplimiento`, y del lado del
    // server porque esconder la pestaña no impide teclear la URL.
    if (!this.revela(user)) {
      throw new ForbiddenException('El historial por cajera es del supervisor. Tus cortes del día están en /tienda/arqueo.');
    }
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
      cajero_code: (query['cajero'] as string) || undefined,
      limit: query['limit'] ? Number(query['limit']) : undefined,
    });
    // Con el 403 de arriba, aca `revela` es siempre true: la proyeccion
    // recortada que habia (sin montos de Kepler, para la cajera) quedo
    // inalcanzable y se fue con ella.
    return res;
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
