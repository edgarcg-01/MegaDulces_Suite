import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  Permission,
  RequireAnyPermission,
  RequirePermissions,
} from '@megadulces/platform-core';
import {
  LogisticsShipmentsService,
  CreateShipmentDto,
  UpdateShipmentDto,
  ShipmentStatus,
} from './logistics-shipments.service';

/**
 * `[AUTHZ.5]` — Controller sin ningún decorador de autorización hasta acá (ver el comentario de
 * `logistics-fleet.controller`). Cualquier autenticado podía crear, despachar, entregar, cerrar,
 * cancelar y **borrar** embarques.
 *
 * ⚠️ **Las transiciones de ruta llevan un OR medido, no de precaución.** Las pantallas que las
 * disparan (`/logistica/shipments*`, incluido el wizard de entrega) están gateadas en el front con
 * `LOGISTICS_SHIPMENTS_VER`, que los 2 `repartidor` de prod **sí** tienen — pero `_GESTIONAR` **no**.
 * Cerrar salida/entrega sólo con `_GESTIONAR` les quitaba algo que hoy hacen. Por eso esas cuatro
 * aceptan además `REPARTO_ENTREGAR`, que es exactamente "esta persona entrega en ruta".
 * Lo administrativo (crear, editar, cancelar, cerrar, costos, borrar) queda en `_GESTIONAR` solo.
 */
@ApiTags('logistics-shipments')
@Controller('logistics/shipments')
export class LogisticsShipmentsController {
  constructor(private readonly service: LogisticsShipmentsService) {}

  @Post()
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Crear shipment (status=programado)' })
  create(@Body() body: CreateShipmentDto) {
    return this.service.create(body);
  }

  @Get()
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Listar shipments con paginación + filtros' })
  list(
    @Query('status') status?: ShipmentStatus,
    @Query('vehicle_id') vehicle_id?: string,
    @Query('driver_id') driver_id?: string,
    @Query('order_id') order_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({
      status,
      vehicle_id,
      driver_id,
      order_id,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('counts')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'J13: conteo de shipments por estado (alimenta la tira de status-chips)' })
  counts(
    @Query('vehicle_id') vehicle_id?: string,
    @Query('driver_id') driver_id?: string,
    @Query('order_id') order_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.counts({ vehicle_id, driver_id, order_id, from, to });
  }

  @Get('pending-orders')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({
    summary: 'J.7.1: pedidos confirmed sin shipment activo (bandeja de entrada de logística)',
  })
  pendingOrders() {
    return this.service.pendingOrders();
  }

  @Get('my-driver')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({
    summary: 'J.9.7: shipments del chofer logueado (lookup logistics.drivers.user_id = JWT user_id)',
  })
  myDriverShipments(
    @Query('status') status?: ShipmentStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.myDriverShipments({ status, from, to });
  }

  @Get('live')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'J12.1: posiciones en vivo de embarques en_ruta (último ping del chofer)' })
  livePositions() {
    return this.service.livePositions();
  }

  @Get(':id/eta')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'J12.4: ETA por parada (posición actual + sequence_order + velocidad)' })
  eta(@Param('id') id: string) {
    return this.service.etaForShipment(id);
  }

  @Get(':id/readiness')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'J12: semáforo de preparación del viaje (qué está listo / qué falta)' })
  readiness(@Param('id') id: string) {
    return this.service.readiness(id);
  }

  @Get(':id')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Obtener shipment por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar shipment (no permitido si cerrado/cancelado)' })
  update(@Param('id') id: string, @Body() body: UpdateShipmentDto) {
    return this.service.update(id, body);
  }

  // ── Transiciones que hace quien va en la ruta ────────────────────────────
  // El OR con `REPARTO_ENTREGAR` está medido (ver el docblock de la clase): los 2 `repartidor` de
  // prod tienen `SHIPMENTS_VER` pero no `_GESTIONAR`, y estas cinco son su flujo.

  @Post(':id/start-salida-checklist')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'J.8.3: programado → checklist_salida (opcional, flujo formal)' })
  startSalidaChecklist(@Param('id') id: string) {
    return this.service.startSalidaChecklist(id);
  }

  @Post(':id/depart')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Transición: programado|checklist_salida → en_ruta' })
  depart(@Param('id') id: string) {
    return this.service.depart(id);
  }

  @Post(':id/deliver')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Transición: en_ruta → entregado' })
  deliver(@Param('id') id: string) {
    return this.service.deliver(id);
  }

  @Post(':id/start-llegada-checklist')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'J.8.3: entregado → checklist_llegada (opcional, flujo formal)' })
  startLlegadaChecklist(@Param('id') id: string) {
    return this.service.startLlegadaChecklist(id);
  }

  /** Cierra el viaje del chofer (libera la unidad). Va en el grupo de ruta: es su último paso. */
  @Post(':id/close')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Transición: (entregado|checklist_llegada|costos_pendientes) → cerrado (libera vehicle, marca order=fulfilled si aplica)' })
  close(@Param('id') id: string) {
    return this.service.close(id);
  }

  // ── Administrativo: sólo `_GESTIONAR` ────────────────────────────────────

  @Post(':id/mark-costs-pending')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'J.8.3: checklist_llegada → costos_pendientes' })
  markCostsPending(@Param('id') id: string) {
    return this.service.markCostsPending(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Cancelar shipment (desde programado o en_ruta)' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancel(id, body?.reason);
  }

  @Delete(':id')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete (solo si cancelado o cerrado)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
