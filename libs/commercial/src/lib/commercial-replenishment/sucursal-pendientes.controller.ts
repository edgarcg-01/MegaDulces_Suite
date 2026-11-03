import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequireAnyPermission } from '@megadulces/platform-core';
import {
  LLAVES_PENDIENTES_SUCURSAL,
  type SucursalPendientesAlmacen,
  type SucursalPendientesResponse,
} from '@megadulces/contracts';
import { SucursalPendientesService, type QuienPidePendientes } from './sucursal-pendientes.service';

/**
 * `[AB.45]` **Pendientes de la sucursal** — todo lo que la Suite tiene abierto de UNA sucursal.
 *
 * La puerta es CUALQUIERA de las llaves de sus colas (`LLAVES_PENDIENTES_SUCURSAL`, la misma lista que
 * la ruta y el sidebar); adentro, cada cola exige la suya y el almacén se recorta al alcance.
 */
@ApiTags('commercial-sucursal-pendientes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/sucursal-pendientes')
export class SucursalPendientesController {
  constructor(private readonly svc: SucursalPendientesService) {}

  @Get('almacenes')
  @RequireAnyPermission(...LLAVES_PENDIENTES_SUCURSAL)
  @ApiOperation({ summary: '[AB.45] Almacenes que la persona alcanza, con la llave de sucursal' })
  almacenes(): Promise<SucursalPendientesAlmacen[]> {
    return this.svc.almacenes();
  }

  @Get()
  @RequireAnyPermission(...LLAVES_PENDIENTES_SUCURSAL)
  @ApiOperation({ summary: '[AB.45] Todas las colas con trabajo de una sucursal (sólo las que la persona puede abrir)' })
  pendientes(
    @Query('warehouse_id') warehouseId?: string,
    @Req() req?: { user?: QuienPidePendientes },
  ): Promise<SucursalPendientesResponse> {
    return this.svc.pendientes(warehouseId, req?.user);
  }
}
