import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ErpShipmentsService } from './erp-shipments.service';

/**
 * EMB — Embarques reales del ERP para la pantalla `/logistica/shipments`.
 *
 * Sólo lectura: el dueño del embarque es Kepler. Reusa el permiso que ya gatea la pantalla
 * (`LOGISTICS_SHIPMENTS_VER`) — es la MISMA superficie, no una nueva, así que crear un permiso
 * aparte sólo habría dejado la pestaña invisible para quien ya entra a Embarques.
 *
 * ⚠️ Las rutas fijas van ANTES que las paramétricas (`today`, `live` antes de `:sucursal/...`),
 * o Nest resuelve `today` como si fuera una sucursal.
 */
@ApiTags('logistics-erp-shipments')
@UseGuards(RolesGuard)
@Controller('logistics/erp-shipments')
export class ErpShipmentsController {
  constructor(private readonly service: ErpShipmentsService) {}

  @Get('today')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'KPIs del día: viajes, paradas, unidades, valor y cuántas traen GPS' })
  today() {
    return this.service.todayKpis();
  }

  @Get('live')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Viajes de hoy con su última posición — alimenta el mapa en vivo. Declara cuántos son ubicables.' })
  live() {
    return this.service.liveToday();
  }

  @Get('trips')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Viajes (guía de embarque) del ERP. El grano es el camión saliendo, no el documento suelto.' })
  trips(@Query() q: any) {
    return this.service.listTrips(q);
  }

  @Get('trips/:sucursal/:guia')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Un viaje: sus paradas, la unidad, dónde está ahora y el recorrido del día' })
  tripDetail(@Param('sucursal') sucursal: string, @Param('guia') guia: string) {
    return this.service.tripDetail(sucursal, guia);
  }

  @Get('lines/:sucursal/:serie/:folio')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Qué lleva esa parada: renglones en la unidad del ERP y su equivalencia en cajas' })
  lines(@Param('sucursal') sucursal: string, @Param('serie') serie: string, @Param('folio') folio: string) {
    return this.service.lines(sucursal, serie, folio);
  }
}
