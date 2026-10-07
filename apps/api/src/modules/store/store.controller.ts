import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Public, RequirePermissions, RequireAnyPermission, Permission, ScopeService, CANONICAL_PARAM } from '@megadulces/platform-core';
import { StoreService } from './store.service';
import { StoreIngestGuard } from './store-ingest.guard';
import { LiveTicket } from './store.types';

@ApiTags('store')
@Controller('store/live')
export class StoreController {
  constructor(
    private readonly service: StoreService,
    private readonly scope: ScopeService,
  ) {}

  /** Ingesta del poller on-prem (máquina-a-máquina, header x-store-ingest-key). */
  @Public()
  @UseGuards(StoreIngestGuard)
  @Post('ingest')
  @ApiOperation({ summary: 'TDA — ingesta de tickets en vivo desde el runner on-prem (upsert + emite por WS /store).' })
  ingest(@Body() body: { tickets: LiveTicket[]; emit?: boolean }) {
    // emit=false → backfill histórico del día (solo llena el buffer, sin emitir
    // por WS ni disparar alertas). El navegador lo recibe vía snapshot.
    return this.service.ingest(body?.tickets || [], body?.emit !== false);
  }

  /**
   * `[TDA.1]` — El hop-2 de `feeds-ingest` avisa que cambiaron precios de etiqueta.
   *
   * Máquina-a-máquina con el MISMO header que la ingesta de tickets: no se estrena un secreto ni un
   * mecanismo. Sólo reemite por WS — no escribe nada, porque el precio ya lo escribió quien avisa.
   *
   * Por qué existe: la cadena Kepler → base tarda segundos, pero la pantalla era 100 % pull y sólo
   * consultaba al escanear. Una etiqueta ya en cola conservaba el precio viejo y se imprimía así.
   */
  @Public()
  @UseGuards(StoreIngestGuard)
  @Post('label-prices-changed')
  @ApiOperation({ summary: 'TDA — aviso del hop-2: estos productos cambiaron de precio de etiqueta (reemite por WS /store).' })
  labelPricesChanged(@Body() body: { tenant_id?: string; product_ids?: string[]; total?: number; truncated?: boolean; at?: string }) {
    return this.service.notifyLabelPricesChanged(body);
  }

  /** Snapshot inicial para el navegador al conectar (KPIs día + horas + últimos). */
  @Get('snapshot')
  @RequirePermissions(Permission.STORE_LIVE_VER)
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV. Se recorta a tu alcance. Acepta los nombres viejos (warehouse, sucursal…).' })
  @ApiOperation({ summary: 'TDA — snapshot del día: KPIs por sucursal + curva horaria + tickets del día. Acotado por tu alcance de sucursales.' })
  async snapshot(@Query() query: Record<string, unknown>) {
    // `[AUTHZ-HARD.3]` — El alcance sale de `ScopeService`, no del viejo
    // `user?.warehouse_code || warehouse`, que era fail-OPEN: a quien no tenía
    // sucursal asignada se le respetaba el query param → veía la red entera.
    // `readParam` devuelve `null` (alcance `all`, sin filtro) o la lista recortada
    // (`[]` = no ve nada). El service filtra con esa distinción.
    const codes = await this.scope.readParam(query, 'warehouse', 'store/snapshot');
    return this.service.snapshot(codes);
  }

  /**
   * TDA.R — ritmo de referencia (7 y 30 días) para comparar contra el día en curso.
   *
   * Endpoint propio y NO parte de `snapshot` a propósito: sale del ODS y la ventana de
   * 30 días tarda ~6 s. Colgar el monitor en vivo detrás de eso sería cambiar una
   * pantalla que responde al instante por una que arranca lenta todos los días. El
   * frontend pinta los KPIs con el snapshot y encima le llegan los deltas.
   */
  @Get('rhythm')
  @RequirePermissions(Permission.STORE_LIVE_VER)
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV. Se recorta a tu alcance.' })
  @ApiOperation({ summary: 'TDA — ritmo semanal y mensual (partidas/ticket, valor/partida, unidades/ticket…) desde el ODS, para comparar contra hoy. Declara cuántos días de la ventana pudo usar.' })
  async rhythm(@Query() query: Record<string, unknown>) {
    const codes = await this.scope.readParam(query, 'warehouse', 'store/rhythm');
    return this.service.rhythm(codes);
  }

  /**
   * SM.10 — cajas abiertas ahora + quién está cobrando (sesión × tickets por caja).
   *
   * `[ID.4]` — El alcance sale de `ScopeService`, no del viejo
   * `user?.warehouse_code || warehouse`: ese patrón era fail-OPEN — a la encargada
   * con sucursal se la forzaba, pero a quien no la tenía se le respetaba el query
   * param, o sea veía la red entera. Es una pantalla que muestra cuánto está
   * entrando en cada caja de cada tienda: el default no puede ser "todas".
   */
  @Get('open-cajas')
  @RequirePermissions(Permission.STORE_LIVE_VER)
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV. Se recorta a tu alcance. Acepta los nombres viejos (warehouse, sucursal…).' })
  @ApiOperation({ summary: 'SM.10 — cajas ABIERTAS ahora + venta del día por caja (Kepler ODS + tickets en vivo). Acotado por tu alcance de sucursales.' })
  async openCajas(@Query() query: Record<string, unknown>) {
    const codes = await this.scope.readParam(query, 'warehouse', 'store/open-cajas');
    return this.service.openSessions(codes);
  }

  /** LM-K.1 — busca un ticket Kepler por folio para armar la entrega a domicilio. */
  @Get('ticket-lookup')
  @RequireAnyPermission(Permission.STORE_LIVE_VER, Permission.REPARTO_DESPACHAR)
  @ApiQuery({ name: 'folio', required: true })
  @ApiQuery({ name: 'serie', required: false })
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal a consultar. El despachador la elige; el usuario scopeado a una sucursal queda fijado a la suya.' })
  @ApiOperation({ summary: 'LM-K — busca ticket de venta Kepler por folio (líneas + total + forma de pago) para despacho a domicilio.' })
  async ticketLookup(
    @Query() query: Record<string, unknown>,
    @Query('folio') folio: string,
    @Query('serie') serie?: string,
  ) {
    // `[AUTHZ-HARD.3]` — Es un lookup por sucursal: se resuelve a UNA sucursal
    // dentro del alcance. `readParam` recorta lo pedido a lo permitido; si queda
    // exactamente una, se usa; si no (alcance `all` sin pedir, o pidió otra fuera
    // de su alcance), el service pide la sucursal (400) — nunca cae a "todas".
    const allowed = await this.scope.readParam(query, 'warehouse', 'store/ticket-lookup');
    const effective = allowed && allowed.length === 1 ? allowed[0] : undefined;
    return this.service.ticketLookup({ folio, serie, warehouseCode: effective });
  }
}
