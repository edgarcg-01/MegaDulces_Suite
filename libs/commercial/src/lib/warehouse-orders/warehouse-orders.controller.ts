import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard, RolesGuard, RequireAnyPermission, RequirePermissions, Permission,
} from '@megadulces/platform-core';
import type { WarehouseOrderDetail, WarehouseOrdersResponse } from '@megadulces/contracts';
import { WarehouseOrdersService } from './warehouse-orders.service';
import { sinImportes } from './warehouse-orders.engine';

/** Lo que `RolesGuard` deja en la petición: los permisos FRESCOS (no los del token). */
type ReqUsuario = { user?: { permissions?: Record<string, boolean> } };

/**
 * `[GP.1]` Tablero de pedidos del almacén (`/almacen/pedidos`): pedidos Kepler `U-D-40`
 * (telemarketing y sucursal) por estatus y periodo. Sólo lectura sobre el ODS (ADR-086).
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

  /**
   * `[MCP.3.2]` El surtidor (`COMMERCIAL_PICKING_GESTIONAR`) también lo lee, para su lista de
   * pedidos con folio y cliente; a él se le responde SIN importes. El detalle sigue siendo sólo del
   * tablero.
   */
  @Get()
  @RequireAnyPermission(Permission.ALMACEN_PEDIDOS_VER, Permission.COMMERCIAL_PICKING_GESTIONAR)
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
    @Req() req?: ReqUsuario,
  ): Promise<WarehouseOrdersResponse> {
    const ve = req?.user?.permissions?.[Permission.ALMACEN_PEDIDOS_VER] === true;
    return this.svc
      .list({ month, from, to, estatus: status, origen: origin, sucursal: branch, q })
      .then((r) => (ve ? r : sinImportes(r)));
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
