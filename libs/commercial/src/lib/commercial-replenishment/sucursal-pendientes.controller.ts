import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type {
  AtribuirPendienteRequest,
  ResponsablePendiente,
  SucursalPendientesAlmacen,
  SucursalPendientesResponse,
} from '@megadulces/contracts';
import { SucursalPendientesService, type QuienPidePendientes } from './sucursal-pendientes.service';

/**
 * `[AB.45]`/`[AB.46]` **Pendientes de sucursal** — módulo propio (`/sucursal`).
 *
 * La puerta es la llave del MÓDULO (`SUCURSAL_PENDIENTES_VER`, repartida a todo rol con personas). Toda
 * la sucursal ve las mismas colas; el almacén se recorta al alcance de la persona (con sucursal en su
 * ficha, la suya; oficinas, las que su alcance diga). Atribuirse y soltar escriben en
 * `commercial.sucursal_pendiente_responsables`.
 */
@ApiTags('commercial-sucursal-pendientes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/sucursal-pendientes')
export class SucursalPendientesController {
  constructor(private readonly svc: SucursalPendientesService) {}

  @Get('almacenes')
  @RequirePermissions(Permission.SUCURSAL_PENDIENTES_VER)
  @ApiOperation({ summary: '[AB.45] Almacenes que la persona alcanza, con la llave de sucursal' })
  almacenes(): Promise<SucursalPendientesAlmacen[]> {
    return this.svc.almacenes();
  }

  @Get()
  @RequirePermissions(Permission.SUCURSAL_PENDIENTES_VER)
  @ApiOperation({ summary: '[AB.46] Todas las colas con trabajo de una sucursal, con quién se atribuyó cada pendiente' })
  pendientes(
    @Query('warehouse_id') warehouseId?: string,
    @Req() req?: { user?: QuienPidePendientes },
  ): Promise<SucursalPendientesResponse> {
    return this.svc.pendientes(warehouseId, req?.user);
  }

  @Post('atribuir')
  @RequirePermissions(Permission.SUCURSAL_PENDIENTES_VER)
  @ApiOperation({ summary: '[AB.46] «Yo lo resuelvo»: atribuirse un pendiente de la sucursal (uno por pendiente)' })
  atribuir(
    @Body() body: AtribuirPendienteRequest,
    @Req() req?: { user?: QuienPidePendientes },
  ): Promise<ResponsablePendiente> {
    return this.svc.atribuir(body, req?.user);
  }

  @Post('soltar')
  @RequirePermissions(Permission.SUCURSAL_PENDIENTES_VER)
  @ApiOperation({ summary: '[AB.46] Soltar un pendiente que te atribuiste' })
  soltar(
    @Body() body: AtribuirPendienteRequest,
    @Req() req?: { user?: QuienPidePendientes },
  ): Promise<{ ok: true }> {
    return this.svc.soltar(body, req?.user);
  }
}
