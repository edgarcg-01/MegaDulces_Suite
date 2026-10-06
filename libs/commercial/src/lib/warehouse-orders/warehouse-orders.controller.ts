import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAuthGuard, RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { WarehouseOrderDetail, WarehouseOrdersResponse } from '@megadulces/contracts';
import { WarehouseOrdersService } from './warehouse-orders.service';

/**
 * `[GP.1]` Tablero de pedidos del almacén (`/almacen/pedidos`): pedidos Kepler `U-D-40`
 * (telemarketing y sucursal) por estatus y periodo. Sólo lectura sobre el ODS (ADR-084).
 *
 * Permiso propio `ALMACEN_PEDIDOS_VER` (repartido por la migración 20261006200000). No es el de
 * surtido: el tablero lo ven telemarketing y facturación, y con aquél se les abría Reparto › Surtido.
 */
@ApiTags('warehouse-orders')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
// URL y parámetros en inglés (convención de CLAUDE.md); la pantalla sigue en /almacen/pedidos.
@Controller('warehouse/orders')
export class WarehouseOrdersController {
  constructor(private readonly svc: WarehouseOrdersService) {}

  @Get()
  @RequirePermissions(Permission.ALMACEN_PEDIDOS_VER)
  @ApiOperation({
    summary:
      'Pedidos Kepler U-D-40 del periodo. Filtros: month (AAAA-MM, default mes en curso) o from+to; status (estatus Kepler, separados por coma), origin (TELEMARK|SUCURSAL), branch (sucursal, 2 dígitos), q.',
  })
  list(
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('origin') origin?: string,
    @Query('branch') branch?: string,
    @Query('q') q?: string,
  ): Promise<WarehouseOrdersResponse> {
    return this.svc.list({ month, from, to, estatus: status, origen: origin, sucursal: branch, q });
  }

  @Get(':branch/:serie/:folio')
  @RequirePermissions(Permission.ALMACEN_PEDIDOS_VER)
  @ApiOperation({ summary: 'Un pedido con sus renglones (cantidades y ubicación por etapa) y sus embarques U-D-41.' })
  detail(
    @Param('branch') branch: string,
    @Param('serie') serie: string,
    @Param('folio') folio: string,
  ): Promise<WarehouseOrderDetail> {
    return this.svc.detail(branch, serie, folio);
  }
}
