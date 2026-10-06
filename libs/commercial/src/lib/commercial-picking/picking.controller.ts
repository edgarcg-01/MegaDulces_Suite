import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CreateWaveDto, PickingService } from './picking.service';

/**
 * SU.2 — Pool de pedidos por surtir y olas de surtido (Fase SU, ADR-067).
 *
 * Vive bajo `reparto/` y no bajo `commercial/` a propósito: el pool y la ola son trabajo de piso
 * —preparar lo que sale a repartir—, no de venta. El pedido (su estado comercial, su precio, su
 * cliente) sigue siendo de `commercial/orders`.
 */
@ApiTags('reparto-surtido')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('reparto/surtido')
export class PickingController {
  constructor(private readonly service: PickingService) {}

  @Get('pool')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({
    summary:
      'Pedidos confirmados que todavía no están en ninguna ola. Declara que lo capturado sin señal aún no llegó.',
  })
  pool(
    @Query('warehouse_id') warehouseId?: string,
    @Query('delivery_date') deliveryDate?: string,
    @Query('limit') limit?: string,
    // [VEC.3] `?route_kind=vecinal` o `?route_kind=vecinal,camion`. Ausente = todos, que es
    // como se comportaba el pool antes de esto.
    @Query('route_kind') routeKind?: string,
    // [VEC.8] UNA ruta concreta. Siempre junto a warehouse_id: la misma ruta vive en dos
    // sucursales, y sola juntaria mercancia de dos bodegas.
    @Query('sales_route') salesRoute?: string,
  ) {
    return this.service.pool({
      warehouse_id: warehouseId,
      delivery_date: deliveryDate,
      limit: limit ? Number(limit) : undefined,
      route_kind: routeKind
        ? routeKind.split(',').map((k) => k.trim()).filter(Boolean)
        : undefined,
      sales_route: salesRoute || undefined,
    });
  }

  /**
   * `[VEC.4]` La bandeja de avisos de la sucursal. `?pendientes=1` = sólo lo no acusado.
   *
   * Recibe `@Query()` entero porque `ScopeService.warehouseIds()` lee de ahí el parámetro
   * canónico de sucursal — es el contrato del primitivo, no un atajo.
   */
  @Get('avisos')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({
    summary:
      'Pedidos de los que se avisó a esta sucursal para que los arme, con su acuse. Sobrevive a que nadie estuviera mirando.',
  })
  avisos(@Query() query: Record<string, unknown>, @Query('pendientes') pendientes?: string) {
    return this.service.avisos(query, pendientes === '1' || pendientes === 'true');
  }

  /**
   * `[VEC.4]` Acuse de un aviso. Idempotente: re-marcar algo ya visto devuelve lo que ya
   * estaba y NO pisa quién lo vio primero.
   *
   * Exige `GESTIONAR` y no `VER` a propósito: acusar es afirmar "yo me hago cargo". Quien
   * sólo mira (dirección, prevención) ve la bandeja pero no puede apagarle el aviso a otro.
   */
  @Post('avisos/:id/visto')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Marca un aviso como visto por quien lo acusa.' })
  marcarVisto(@Param('id') id: string) {
    return this.service.marcarVisto(id);
  }

  @Get('waves')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Lista de olas (bandeja del jefe de almacén).' })
  list(@Query('status') status?: string) {
    return this.service.list(status);
  }

  @Get('waves/:id')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({
    summary:
      'Detalle de la ola: pedidos + consolidado por SKU con su unidad y el desglose por pedido.',
  })
  byId(@Param('id') id: string) {
    return this.service.byId(id);
  }

  @Post('waves')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Arma una ola con los pedidos dados (folio W-YYYY-NNNNN).' })
  create(@Body() dto: CreateWaveDto) {
    return this.service.createWave(dto);
  }

  /**
   * `[VEC.5]` El "pedido global" en un clic: arma una ola con todo lo que falta surtir de un
   * tipo de ruta. `{ warehouse_id, delivery_date?, route_kind?: ['vecinal'], assigned_to? }`.
   *
   * Idempotente en la práctica: repetirlo no duplica nada porque el pool ya excluye lo que
   * está en una ola viva — la segunda vez responde `creada: false`.
   */
  @Post('waves/auto')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({
    summary:
      'Arma una ola con los pedidos pendientes de un tipo de ruta (el pedido global). No crea olas vacías.',
  })
  crearOlaAuto(
    @Body()
    body: {
      warehouse_id: string;
      delivery_date?: string;
      route_kind?: string[];
      /** `[VEC.8]` Armar la ola de UNA ruta: una ola = una ruta, mercancía ya separada. */
      sales_route?: string;
      assigned_to?: string;
    },
  ) {
    return this.service.crearOlaAuto(body);
  }

  @Post('waves/:id/assign')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Asigna o reasigna la ola a un surtidor.' })
  assign(@Param('id') id: string, @Body() body: { assigned_to: string }) {
    return this.service.assign(id, body?.assigned_to);
  }

  @Post('waves/:id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Cancela la ola; sus pedidos vuelven solos al pool.' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancelWave(id, body?.reason);
  }

  // ─── Surtido (SU.4). Misma persona, misma pantalla: no hay permiso aparte de "surtidor" ───

  @Post('waves/:id/start')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({
    summary: 'Arranca el surtido: congela el consolidado en renglones y pone la ola en_surtido.',
  })
  start(@Param('id') id: string) {
    return this.service.startPicking(id);
  }

  @Get('waves/:id/lines')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Renglones de la ola con su avance (lo pendiente primero).' })
  lines(@Param('id') id: string) {
    return this.service.lines(id);
  }

  @Post('waves/:id/lines/:lineId/pick')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({
    summary:
      'Marca cuánto se levantó de un renglón (y por qué, si no fue todo). No detiene el surtido.',
  })
  pick(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: { qty_picked: number; status?: string; note?: string; bin_code?: string },
  ) {
    return this.service.pickLine(id, lineId, body);
  }

  @Get('waves/:id/allocations')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({
    summary:
      'SU.6 — a qué pedido le toca cada cosa (la hoja con la que se separa), agrupado por cliente.',
  })
  allocations(@Param('id') id: string) {
    return this.service.allocations(id);
  }

  @Post('waves/:id/orders/:orderId/verify')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({
    summary:
      'SU.7 — re-verifica UN pedido ya separado y lo deja listo para embarque. Registra quién lo verificó.',
  })
  verify(@Param('id') id: string, @Param('orderId') orderId: string) {
    return this.service.verifyOrder(id, orderId);
  }

  @Post('waves/:id/finish')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Cierra el surtido. Exige que ningún renglón quede sin tocar.' })
  finish(@Param('id') id: string) {
    return this.service.finishPicking(id);
  }
}
