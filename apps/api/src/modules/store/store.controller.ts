import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Public, RequirePermissions, RequireAnyPermission, Permission, ReqUser, ScopeService, CANONICAL_PARAM } from '@megadulces/platform-core';
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

  /** Snapshot inicial para el navegador al conectar (KPIs día + horas + últimos). */
  @Get('snapshot')
  @RequirePermissions(Permission.STORE_LIVE_VER)
  @ApiQuery({ name: 'warehouse', required: false, description: "Filtro por sucursal ('00'..'05'). Ignorado si el usuario ya está scopeado a una sucursal." })
  @ApiOperation({ summary: 'TDA — snapshot del día: KPIs por sucursal + curva horaria + tickets del día.' })
  snapshot(@ReqUser() user: { warehouse_code?: string } | undefined, @Query('warehouse') warehouse?: string) {
    // Usuario con sucursal asignada → SIEMPRE su sucursal (no puede ampliar).
    // Rol global (sin warehouse_code) → filtro opcional del UI.
    const effective = user?.warehouse_code || warehouse || undefined;
    return this.service.snapshot(effective);
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
  @ApiQuery({ name: 'warehouse', required: false, description: "Sucursal ('01'..'03'). Ignorado si el usuario ya está scopeado a una sucursal." })
  @ApiOperation({ summary: 'LM-K — busca ticket de venta Kepler por folio (líneas + total + forma de pago) para despacho a domicilio.' })
  ticketLookup(
    @ReqUser() user: { warehouse_code?: string } | undefined,
    @Query('folio') folio: string,
    @Query('serie') serie?: string,
    @Query('warehouse') warehouse?: string,
  ) {
    const effective = user?.warehouse_code || warehouse || undefined;
    return this.service.ticketLookup({ folio, serie, warehouseCode: effective });
  }
}
