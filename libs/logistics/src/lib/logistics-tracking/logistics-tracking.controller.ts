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
import { FleetAlertsService } from './fleet-alerts.service';
import { TripBuilderService } from './trip-builder.service';
import { RouteAdherenceService } from './route-adherence.service';

@ApiTags('logistics-tracking')
@UseGuards(RolesGuard)
@Controller('logistics/tracking')
export class LogisticsTrackingController {
  constructor(
    private readonly service: LogisticsTrackingService,
    private readonly alerts: FleetAlertsService,
    private readonly trips: TripBuilderService,
    private readonly adherence: RouteAdherenceService,
  ) {}

  // ── LTV.1 Cumplimiento de ruta (plan vs real) ──────────────────────────────
  @Get('adherence')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Cumplimiento de ruta de un vehículo en un día' })
  adherenceForVehicle(@Query('vehicle_id') vehicleId: string, @Query('date') date: string) {
    return this.adherence.forVehicleDay(vehicleId, date);
  }

  // ── LTV.0 Viajes / paradas reconstruidas ───────────────────────────────────
  @Get('trips/day-summary')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Resumen diario por vehículo (km, paradas, tiempos)' })
  daySummary(@Query('date') date: string) {
    return this.trips.listDaySummary(date);
  }

  @Get('trips/:vehicleId/stops')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Paradas de un vehículo en un día' })
  stops(@Param('vehicleId') vehicleId: string, @Query('date') date: string) {
    return this.trips.listStops(vehicleId, date);
  }

  @Post('trips/rebuild')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Reconstruir viajes/paradas de una fecha (o un vehículo)' })
  rebuild(@Query('date') date: string, @Query('vehicle_id') vehicleId?: string) {
    return vehicleId ? this.trips.buildForVehicleDay(vehicleId, date) : this.trips.buildForDate(date);
  }

  // ── Alertas de flota (server-side, persistidas) ────────────────────────────
  @Get('alerts')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Alertas de flota activas (offline / velocidad)' })
  listAlerts() {
    return this.alerts.listActive();
  }

  @Post('alerts/scan-now')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Correr el scanner de alertas ahora' })
  scanAlerts() {
    return this.alerts.scan();
  }

  @Patch('alerts/:id/ack')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Reconocer (silenciar) una alerta' })
  ackAlert(@Param('id') id: string) {
    return this.alerts.acknowledge(id);
  }

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
