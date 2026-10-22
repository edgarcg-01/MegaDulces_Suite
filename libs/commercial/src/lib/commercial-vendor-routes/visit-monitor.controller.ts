import type { VisitMonitorResponse } from '@megadulces/contracts';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import { VisitMonitorService } from './visit-monitor.service';

/**
 * `[MCP.3.7]` Monitoreo de visitas del día (supervisor de ventas).
 *
 * Permiso: `COMMERCIAL_CARTERA_VER`, el de «Cartera / asignación», que es donde vive la pantalla. No
 * se inventa uno nuevo: lo que acota QUÉ se ve no es el permiso sino el equipo (`supervisor_id`) —
 * un vendedor con el mismo permiso sólo se ve a sí mismo.
 */
@ApiTags('commercial-vendor-routes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/vendor-routes')
export class VisitMonitorController {
  constructor(private readonly monitor: VisitMonitorService) {}

  @Get('visits/monitor')
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_VER)
  @ApiOperation({
    summary:
      'MCP.3.7: visitas del día por vendedor de tu equipo (?date=YYYY-MM-DD&user_id=): con pedido, sin pedido, faltas y lo no medido',
  })
  visitsMonitor(@Query('date') date?: string, @Query('user_id') userId?: string): Promise<VisitMonitorResponse> {
    return this.monitor.monitor(date, userId);
  }
}
