import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialTrackingService, IngestPoint } from './commercial-tracking.service';

/**
 * Tracking de campo. El propio usuario (vendedor/colaborador) reporta su posición
 * (VISITAS_REGISTRAR, que ambos roles tienen); el supervisor lee rutas y posición
 * viva del equipo (REPORTES_VER_EQUIPO). Sin permisos nuevos (no toca ability.factory).
 */
@ApiTags('commercial-tracking')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/tracking')
export class CommercialTrackingController {
  constructor(private readonly service: CommercialTrackingService) {}

  @Post('ping')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({ summary: 'Reporta un lote de pings GPS del usuario logueado' })
  ping(@Body() body: { points: IngestPoint[] }) {
    return this.service.ingest(body?.points || []);
  }

  @Get('routes')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({ summary: 'Rutas consolidadas del usuario logueado (?from&to)' })
  myRoutes(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.myRoutes(from, to);
  }

  @Get('routes/:userId')
  @RequirePermissions(Permission.REPORTES_VER_EQUIPO)
  @ApiOperation({ summary: 'Rutas consolidadas de un usuario (supervisor)' })
  routesForUser(
    @Param('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.routesForUser(userId, from, to);
  }

  @Get('live')
  @RequirePermissions(Permission.REPORTES_VER_EQUIPO)
  @ApiOperation({ summary: 'Posición viva del equipo (para el mapa)' })
  live() {
    return this.service.teamLive();
  }

  @Post('consolidate')
  @RequirePermissions(Permission.REPORTES_GESTIONAR)
  @ApiOperation({ summary: 'Consolida una fecha (YYYY-MM-DD) manualmente' })
  consolidate(@Body() body: { date: string }) {
    return this.service.consolidateDate(body?.date);
  }
}
