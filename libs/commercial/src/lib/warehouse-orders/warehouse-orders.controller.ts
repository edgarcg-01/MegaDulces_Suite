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
@ApiTags('almacen-pedidos')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('almacen/pedidos')
export class WarehouseOrdersController {
  constructor(private readonly svc: WarehouseOrdersService) {}

  @Get()
  @RequirePermissions(Permission.ALMACEN_PEDIDOS_VER)
  @ApiOperation({
    summary:
      'Pedidos Kepler U-D-40 del periodo. Filtros: month (AAAA-MM, default mes en curso) o from+to; estatus (coma), origen (TELEMARK|SUCURSAL), sucursal, q.',
  })
  list(
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('estatus') estatus?: string,
    @Query('origen') origen?: string,
    @Query('sucursal') sucursal?: string,
    @Query('q') q?: string,
  ): Promise<WarehouseOrdersResponse> {
    return this.svc.list({ month, from, to, estatus, origen, sucursal, q });
  }

  @Get(':sucursal/:serie/:folio')
  @RequirePermissions(Permission.ALMACEN_PEDIDOS_VER)
  @ApiOperation({ summary: 'Un pedido con sus renglones (cantidades y ubicación por etapa) y sus embarques U-D-41.' })
  detail(
    @Param('sucursal') sucursal: string,
    @Param('serie') serie: string,
    @Param('folio') folio: string,
  ): Promise<WarehouseOrderDetail> {
    return this.svc.detail(sucursal, serie, folio);
  }
}
