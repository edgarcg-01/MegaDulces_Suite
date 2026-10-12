import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions } from '@megadulces/platform-core';
import type { CargadoresBody, CerrarParadaBody, CierreDeEmbarque, ParadaCierre } from '@megadulces/contracts';
import { TripClosureService } from './trip-closure.service';

/**
 * `[EMB.24]` `[EMB.27]` — Cierre del viaje (ADR-091). Lo opera Logística: cierra las paradas de
 * cliente (entregado o no, con foto de la remisión opcional) y registra quién cargó. Traspasos y cargas a ruta los cierra
 * Kepler solo; aquí sólo se leen.
 */
@ApiTags('logistics-trip-closure')
@Controller('logistics/trip-closure')
export class TripClosureController {
  constructor(private readonly service: TripClosureService) {}

  @Get('shipments/:id')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'EMB.26: estado del viaje, cierre por parada, lo que se libera por persona y cargadores' })
  cierre(@Param('id') id: string): Promise<CierreDeEmbarque> {
    return this.service.cierre(id);
  }

  @Post('paradas/:recipientId/cierre')
  @RequirePermissions(Permission.LOGISTICS_GUIDES_GESTIONAR)
  @ApiOperation({ summary: 'EMB.24: cerrar una parada de cliente (entregado + quién recibió, o no entregado + motivo; foto opcional)' })
  cerrarParada(@Param('recipientId') recipientId: string, @Body() body: CerrarParadaBody): Promise<ParadaCierre> {
    return this.service.cerrarParada(recipientId, body);
  }

  @Put('shipments/:id/cargadores')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'EMB.27: registrar quién cargó el embarque (tarifa de carga por persona)' })
  cargadores(@Param('id') id: string, @Body() body: CargadoresBody): Promise<CierreDeEmbarque> {
    return this.service.setCargadores(id, body);
  }
}
