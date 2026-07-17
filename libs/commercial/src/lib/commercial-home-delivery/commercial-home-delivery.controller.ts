import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CommercialHomeDeliveryService } from './commercial-home-delivery.service';
import { HomeDeliveryIntakeDto, RecordDeliveryOutcomeDto } from './dto/home-delivery.dto';
import { DispatchFromKeplerDto, DispatchOrderDto, HomeDispatchService } from './home-dispatch.service';

@ApiTags('commercial-home-delivery')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/home-delivery')
export class CommercialHomeDeliveryController {
  constructor(
    private readonly service: CommercialHomeDeliveryService,
    private readonly dispatch: HomeDispatchService,
  ) {}

  /** Intake de un pedido a domicilio (cliente casual o de cartera + dirección). */
  @Post('orders')
  @RequirePermissions(Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'Recibe un pedido a domicilio y lo deja confirmado (stock reservado).' })
  createIntake(@Body() dto: HomeDeliveryIntakeDto) {
    return this.service.createIntake(dto);
  }

  /** El repartidor cierra la parada: entrega (evidencia + cobro) o incidencia. */
  @Post('recipients/:recipientId/outcome')
  @RequirePermissions(Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Registra el resultado de la parada (entregado/incidencia) + POD + cobro.' })
  recordOutcome(@Param('recipientId') recipientId: string, @Body() dto: RecordDeliveryOutcomeDto) {
    return this.service.recordDeliveryOutcome(recipientId, dto);
  }

  // ── Despacho (persona de tienda asigna repartidor + moto) ──

  /** Repartidores asignables (usuarios con rol repartidor; opcional scope por sucursal). */
  @Get('riders')
  @RequirePermissions(Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'Lista usuarios repartidor asignables (dominio Reparto, no flota logística).' })
  listRiders(@Query('warehouse_code') warehouseCode?: string) {
    return this.dispatch.listRiders({ warehouse_code: warehouseCode });
  }

  /** Despacha un pedido de intake propio (commercial.orders home_delivery). */
  @Post('dispatch/:orderId')
  @RequirePermissions(Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'Asigna un pedido a domicilio (intake propio) a un repartidor+moto.' })
  dispatchOrder(@Param('orderId') orderId: string, @Body() dto: DispatchOrderDto) {
    return this.dispatch.dispatchOrder(orderId, dto);
  }

  /** Despacha desde un folio de Kepler (referencia el ticket; no materializa orden). */
  @Post('dispatch-from-kepler')
  @RequirePermissions(Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'Captura folio Kepler + dirección → crea la entrega y la asigna a un repartidor+moto.' })
  dispatchFromKepler(@Body() dto: DispatchFromKeplerDto) {
    return this.dispatch.dispatchFromKepler(dto);
  }

  /** LM.10 — Ruta óptima del repartidor autenticado (orden de visita + km + origen). */
  @Get('my-route')
  @RequirePermissions(Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Ruta óptima del repartidor: paradas pendientes ordenadas + km + origen.' })
  myRoute(@Query('date') date?: string) {
    return this.dispatch.myRoute({ date });
  }

  /** LM.10 — Última posición conocida de cada repartidor (seed del mapa de tienda). */
  @Get('rider-positions')
  @RequirePermissions(Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'Última posición por repartidor (seed; el vivo llega por WS route_ping).' })
  riderPositions(@Query('since_min') sinceMin?: string) {
    return this.dispatch.riderPositions({ sinceMin: sinceMin ? +sinceMin : undefined });
  }

  /** Tracking para tienda: dónde va cada pedido despachado (estado + repartidor + hora). */
  @Get('dispatched')
  @RequirePermissions(Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'Entregas despachadas del día con su estado (tracking de tienda).' })
  listDispatched(
    @Query('warehouse_code') warehouseCode?: string,
    @Query('date') date?: string,
    @Query('status') status?: string,
  ) {
    return this.dispatch.listDispatched({ warehouse_code: warehouseCode, date, status });
  }

  /** Paradas a domicilio del repartidor autenticado (app repartidor). */
  @Get('my-deliveries')
  @RequirePermissions(Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Lista las paradas a domicilio asignadas al repartidor.' })
  myDeliveries(@Query('pending') pending?: string) {
    return this.dispatch.myDeliveries({ pending: pending !== 'false' });
  }

  /** KPIs de última milla (§13): éxito, incidencias, tiempo, cuadre de efectivo. */
  @Get('kpis')
  @RequirePermissions(Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'KPIs de entrega a domicilio en un rango (§13 SOP).' })
  kpis(@Query('from') from?: string, @Query('to') to?: string) {
    return this.dispatch.kpis({ from, to });
  }
}
