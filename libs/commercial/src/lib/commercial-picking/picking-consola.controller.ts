import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAuthGuard, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { ConsolaSurtidoAlmacen, ConsolaSurtidoResponse, KeplerWavesAutoResponse } from '@megadulces/contracts';
import { PickingConsolaService } from './picking-consola.service';

/**
 * `[GP.3c.2]` La consola de surtido: quién prioriza la fila (`FASE_GP` §8.3).
 *
 * TODO con `ALMACEN_SURTIDO_COORDINAR` y no con `COMMERCIAL_PICKING_GESTIONAR`: ésa la tiene el
 * surtidor, y el que surte no se prioriza a sí mismo (decisión de Francisco, 2026-10-08).
 */
@ApiTags('reparto-surtido')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('reparto/surtido/consola')
export class PickingConsolaController {
  constructor(private readonly service: PickingConsolaService) {}

  @Get('almacenes')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Los almacenes que quien consulta puede manejar desde la consola (su alcance).' })
  almacenes(): Promise<ConsolaSurtidoAlmacen[]> {
    return this.service.almacenes();
  }

  @Get()
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({
    summary:
      'La fila de surtidos en el orden en que se van a tomar (urgente → salida → antigüedad), con quién trae cada uno, los destinos del día y lo que falta armar.',
  })
  consola(@Query('warehouse_id') warehouseId: string): Promise<ConsolaSurtidoResponse> {
    return this.service.consola(warehouseId);
  }

  @Post('waves/:id/prioridad')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Marca o quita urgente. Marcarlo exige motivo.' })
  prioridad(
    @Param('id') id: string,
    @Body() body: { urgente: boolean; motivo?: string },
  ): Promise<{ id: string; prioridad: 0 | 1 }> {
    return this.service.prioridad(id, body);
  }

  @Post('waves/:id/liberar')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Quita el surtido a quien lo trae: vuelve a la fila con lo ya marcado.' })
  liberar(@Param('id') id: string): Promise<{ id: string; liberada: true }> {
    return this.service.liberar(id);
  }

  @Post('waves/:id/cancelar')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Cancela el surtido (exige motivo); sus pedidos vuelven a la fila.' })
  cancelar(@Param('id') id: string, @Body() body: { motivo?: string }): Promise<{ id: string; cancelada: true }> {
    return this.service.cancelar(id, body);
  }

  @Put('salidas')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Hora de salida de un destino HOY (HH:MM). null la borra.' })
  salida(
    @Body() body: { warehouse_id: string; destino_code: string; destino_nombre?: string | null; hora_salida: string | null },
  ): Promise<{ destino_code: string; hora_salida: string | null }> {
    return this.service.salida(body);
  }

  @Put('ajustes')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Umbral de la tanda del almacén (1 a 50 renglones).' })
  umbral(@Body() body: { warehouse_id: string; umbral_tanda: number }): Promise<{ umbral_tanda: number }> {
    return this.service.umbral(body);
  }

  @Post('armar')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Arma ya los surtidos de los pedidos autorizados pendientes.' })
  armar(@Body() body: { warehouse_id: string; origen?: string }): Promise<KeplerWavesAutoResponse> {
    return this.service.armar(body);
  }
}
