import type { SetVendorTargetRequest, SetVendorTargetResponse, SupervisorBoardResponse } from '@megadulces/contracts';
import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard, isPlatformAdminRole } from '@megadulces/platform-core';
import { SupervisorBoardService } from './supervisor-board.service';

/**
 * `[MCP.3.9]` Tablero del supervisor de ventas (dentro de «Cartera de ventas»).
 *
 *  · Leer: `COMMERCIAL_CARTERA_VER`, el permiso de la pantalla. Lo que acota QUÉ se ve es el equipo
 *    (`supervisor_id`) y el tipo de ruta del puesto, no el permiso.
 *  · Capturar la meta: `USUARIOS_ASIGNAR_RUTA` — el que tiene `supervisor_ventas` (que NO tiene
 *    `COMMERCIAL_CARTERA_GESTIONAR`: verificado en docs/MATRIZ_ACCESOS.md, generada de prod, donde
 *    «Cartera / asignación» le sale en V). `can_set_targets` de la respuesta es ese mismo permiso.
 *
 * ⚠️ Rutas literales (`supervisor/…`): este controlador comparte prefijo con
 * `CommercialVendorRoutesController`, que tiene `DELETE :id`. Se registra ANTES en el módulo.
 */
@ApiTags('commercial-vendor-routes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/vendor-routes')
export class SupervisorBoardController {
  constructor(private readonly board: SupervisorBoardService) {}

  @Get('supervisor/board')
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_VER)
  @ApiOperation({
    summary:
      'MCP.3.9: tablero del supervisor (?date=YYYY-MM-DD): por vendedor de tu equipo y tu tipo de ruta, inicio/fin, visitados, venta cobrada en Kepler del día y de la catorcena, meta y avance',
  })
  getBoard(
    @Query('date') date?: string,
    @Req() req?: { user?: { permissions?: Record<string, boolean>; role_name?: string } },
  ): Promise<SupervisorBoardResponse> {
    // `req.user.permissions` lo escribe RolesGuard con el mapa fresco de la DB.
    const canSetTargets =
      req?.user?.permissions?.[Permission.USUARIOS_ASIGNAR_RUTA] === true || isPlatformAdminRole(req?.user?.role_name);
    return this.board.board(date, canSetTargets);
  }

  @Put('supervisor/targets')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'MCP.3.9: captura (o borra con amount=null) la meta de la catorcena de un vendedor de tu equipo' })
  setTarget(@Body() body: SetVendorTargetRequest): Promise<SetVendorTargetResponse> {
    return this.board.setTarget(body);
  }
}
