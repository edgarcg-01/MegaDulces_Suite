import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { StockSnapshotService } from './stock-snapshot.service';

/**
 * AB.0b — disparo manual y lectura de la **foto de inventario**.
 *
 * El cron de las 23:50 MX es quien la toma todos los días; esto existe para dos cosas
 * concretas, no por simetría:
 *
 *  1. **Re-tomar un día** que salió mal (la escritura es idempotente por la PK, así que
 *     re-correr corrige en vez de duplicar). Sin esto, un día torcido queda torcido para
 *     siempre — y es el único dato del sistema que no se puede reconstruir después.
 *  2. **Probar el camino real** desde la suite de regresión, en vez de que un test
 *     reimplemente el SQL del servicio y termine comprobándose a sí mismo.
 *
 * Gateado con `EXISTENCIA_GESTIONAR`: escribe historia oficial de inventario, así que pide
 * el mismo privilegio que el export valuado de la red, no el de mirar la pantalla.
 */
@ApiTags('commercial-stock-snapshot')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/stock-snapshot')
export class StockSnapshotController {
  constructor(private readonly service: StockSnapshotService) {}

  @Post('run')
  @RequirePermissions(Permission.EXISTENCIA_GESTIONAR)
  @ApiOperation({ summary: 'Toma la foto de inventario ahora (idempotente por fecha de corte)' })
  run(@Body() body: { fecha?: string }) {
    return this.service.snapshotAllTenants(body?.fecha);
  }

  /**
   * La cobertura, NO las filas. Es lo que contesta *"¿qué almacén se fotografió qué día?"*,
   * que es la pregunta que distingue "tenía cero" de "no se midió". Las filas de detalle se
   * consultan por producto desde las pantallas de AB, no acá.
   */
  @Get('coverage')
  @RequirePermissions(Permission.EXISTENCIA_VER)
  @ApiOperation({ summary: 'Qué almacenes se fotografiaron, por fecha de corte' })
  coverage(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.service.coverage(desde, hasta);
  }
}
