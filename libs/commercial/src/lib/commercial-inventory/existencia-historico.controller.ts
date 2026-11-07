import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ExistenciaHistorico, ExistenciaHistoricoDetalle } from '@megadulces/contracts';
import { ExistenciaHistoricoService } from './existencia-historico.service';

/**
 * `[EX.H1]` «Consulta históricos» de Existencia: el valor del inventario de cada sucursal al cierre
 * de cada día, a costo estándar. Sólo lectura.
 *
 * Mismo permiso que la pantalla Existencia (`EXISTENCIA_VER`, D4 de Francisco): quien ya ve el valor
 * de hoy ve su historia. Controlador PROPIO (y no un método más de `StockSnapshotController`) para no
 * cambiar la firma inyectada de una clase que ya arranca en prod: el #414 tiró la API con el CI en verde
 * por exactamente eso. Este servicio pide lo mismo que `ExistenciaService` (tenant + knex del tenant).
 */
@ApiTags('commercial-existencia')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/stock-snapshot/historico')
export class ExistenciaHistoricoController {
  constructor(private readonly service: ExistenciaHistoricoService) {}

  @Get()
  @RequirePermissions(Permission.EXISTENCIA_VER)
  @ApiOperation({ summary: 'Valor del inventario por sucursal al cierre de cada día (costo estándar)' })
  historico(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    // CSV o repetido en la URL (`?almacenes=01&almacenes=02` llega como arreglo): el servicio acepta los dos.
    @Query('almacenes') almacenes?: string | string[],
  ): Promise<ExistenciaHistorico> {
    return this.service.historico({ desde, hasta, almacenes });
  }

  /** El desglose de una celda: los productos de un almacén en un día, con su valor y lo que no suma. */
  @Get('detalle')
  @RequirePermissions(Permission.EXISTENCIA_VER)
  @ApiOperation({ summary: 'Productos de un almacén al cierre de un día, valuados a costo estándar' })
  detalle(
    @Query('fecha') fecha?: string,
    @Query('almacen') almacen?: string,
  ): Promise<ExistenciaHistoricoDetalle> {
    return this.service.detalle({ fecha, almacen });
  }
}
