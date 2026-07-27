import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { LogisticsTrackingService } from './logistics-tracking.service';

@ApiTags('logistics-tracking')
@UseGuards(RolesGuard)
@Controller('logistics/tracking')
export class LogisticsTrackingController {
  constructor(private readonly service: LogisticsTrackingService) {}

  @Get('live')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Última posición de cada tracker (mapa en vivo)' })
  live() {
    return this.service.listLive();
  }

  @Get('trackers')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Registro de dispositivos GPS' })
  trackers() {
    return this.service.listTrackers();
  }

  @Get('trackers/:id/history')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Recorrido histórico (breadcrumbs) de un tracker' })
  history(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.history(id, from, to);
  }

  @Post('sync-now')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Forzar un sync inmediato con el proveedor' })
  syncNow() {
    return this.service.sync();
  }

  @Post('bootstrap-vehicles')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Crear vehículos desde los trackers sin vincular (por placa)' })
  bootstrapVehicles() {
    return this.service.bootstrapVehicles();
  }

  @Patch('trackers/:id/link')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Vincular/desvincular un tracker a un vehículo' })
  link(@Param('id') id: string, @Body() body: { vehicle_id: string | null }) {
    return this.service.linkTracker(id, body?.vehicle_id ?? null);
  }
}
