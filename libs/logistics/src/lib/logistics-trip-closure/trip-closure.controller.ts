import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions } from '@megadulces/platform-core';
import type { BandejaDeViajes, CargadoresBody, CerrarParadaBody, CierreDeEmbarque, ParadaCierre } from '@megadulces/contracts';
import { TripClosureService } from './trip-closure.service';

/**
 * `[EMB.24]` `[EMB.27]` — Cierre del viaje (ADR-091). Lo opera Logística: cierra las paradas de
 * cliente (entregado o no, con foto de la remisión opcional) y registra quién cargó. Traspasos y cargas a ruta los cierra
 * Kepler solo; aquí sólo se leen.
 *
 * `[EMB.43]` Logística › Pagos de viaje entra con su permiso propio (`LOGISTICS_PAGOS_*`): la
 * persona que arma la catorcena no administra embarques. Leer con VER; escribir con GESTIONAR.
 */
@ApiTags('logistics-trip-closure')
@Controller('logistics/trip-closure')
export class TripClosureController {
  constructor(private readonly service: TripClosureService) {}

  @Get('bandeja')
  @RequirePermissions(Permission.LOGISTICS_PAGOS_VER)
  @ApiOperation({ summary: 'EMB.43: los viajes de Kepler de la catorcena (traspaso y cliente) y lo que le falta a cada uno para pagarse' })
  bandeja(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('sucursal') sucursal?: string,
  ): Promise<BandejaDeViajes> {
    return this.service.bandeja(desde, hasta, sucursal);
  }

  @Get('shipments/:id')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_VER, Permission.LOGISTICS_PAGOS_VER)
  @ApiOperation({ summary: 'EMB.26: estado del viaje, cierre por parada, lo que se libera por persona y cargadores' })
  cierre(@Param('id') id: string): Promise<CierreDeEmbarque> {
    return this.service.cierre(id);
  }

  @Post('paradas/:recipientId/cierre')
  @RequireAnyPermission(Permission.LOGISTICS_GUIDES_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR)
  @ApiOperation({ summary: 'EMB.24: cerrar una parada de cliente (entregado + quién recibió, o no entregado + motivo; foto opcional)' })
  cerrarParada(@Param('recipientId') recipientId: string, @Body() body: CerrarParadaBody): Promise<ParadaCierre> {
    return this.service.cerrarParada(recipientId, body);
  }

  @Put('shipments/:id/cargadores')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR)
  @ApiOperation({ summary: 'EMB.27/EMB.39: registrar quién cargó el embarque (cajas × tarifa por caja, repartido)' })
  cargadores(@Param('id') id: string, @Body() body: CargadoresBody): Promise<CierreDeEmbarque> {
    return this.service.setCargadores(id, body);
  }
}
