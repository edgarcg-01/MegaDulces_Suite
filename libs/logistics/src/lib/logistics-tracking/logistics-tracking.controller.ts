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
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import { LogisticsTrackingService } from './logistics-tracking.service';
import { FleetAlertsService } from './fleet-alerts.service';
import { TripBuilderService } from './trip-builder.service';
import { RouteAdherenceService } from './route-adherence.service';
import { FleetProductivityService } from './fleet-productivity.service';

@ApiTags('logistics-tracking')
@UseGuards(RolesGuard)
@Controller('logistics/tracking')
export class LogisticsTrackingController {
  constructor(
    private readonly service: LogisticsTrackingService,
    private readonly alerts: FleetAlertsService,
    private readonly trips: TripBuilderService,
    private readonly adherence: RouteAdherenceService,
    private readonly productivity: FleetProductivityService,
  ) {}

  // ── LTV.5 Productividad / tiempos muertos ──────────────────────────────────
  @Get('productivity')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Productividad de la flota en un día (tiempos muertos, km/entrega)' })
  productivityForDay(@Query('date') date: string, @Query('fleet') fleet?: 'route' | 'logistics') {
    return this.productivity.forFleetDay(date, fleet);
  }

  // ── LTV.1 Cumplimiento de ruta (plan vs real) ──────────────────────────────
  @Get('adherence')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Cumplimiento de ruta de un vehículo en un día' })
  adherenceForVehicle(@Query('vehicle_id') vehicleId: string, @Query('date') date: string) {
    return this.adherence.forVehicleDay(vehicleId, date);
  }

  @Get('adherence/day')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Cumplimiento de ruta de toda la flota en un día (auditoría)' })
  adherenceForFleet(@Query('date') date: string) {
    return this.adherence.forFleetDay(date);
  }

  @Get('adherence/diagnostic')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Por qué no hay cumplimiento ese día (cadena de eslabones)' })
  adherenceDiagnostic(@Query('date') date: string) {
    return this.adherence.diagnose(date);
  }

  @Get('audit-detail')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Detalle de auditoría de un vehículo/día: traza GPS + paradas + tickets ubicados' })
  auditDetail(@Query('vehicle_id') vehicleId: string, @Query('date') date: string) {
    return this.adherence.vehicleAuditDetail(vehicleId, date);
  }

  @Get('audit-detail/route')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Recorrido del vehículo pegado a calles (Mapbox Map Matching)' })
  auditRoute(@Query('vehicle_id') vehicleId: string, @Query('date') date: string) {
    return this.adherence.snapAuditRoute(vehicleId, date);
  }

  @Get('fleet-audit-detail')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Detalle geográfico multi-ruta del día (mapa principal): traza + paradas + tickets + tiendas por unidad' })
  fleetAuditDetail(@Query('date') date: string, @Query('routes') routes?: string) {
    const routeNumbers = (routes || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    return this.adherence.fleetAuditDetail(date, routeNumbers.length ? routeNumbers : undefined);
  }

  // ── LTV.0 Viajes / paradas reconstruidas ───────────────────────────────────
  @Get('trips/day-summary')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Resumen diario por vehículo (km, paradas, tiempos)' })
  daySummary(@Query('date') date: string, @Query('fleet') fleet?: 'route' | 'logistics') {
    return this.trips.listDaySummary(date, fleet);
  }

  @Get('trips/:vehicleId/stops')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
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
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
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
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Última posición de cada tracker (mapa en vivo)' })
  live(@Query('fleet') fleet?: 'route' | 'logistics') {
    return this.service.listLive(fleet);
  }

  @Get('trackers')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Registro de dispositivos GPS' })
  trackers() {
    return this.service.listTrackers();
  }

  @Get('trackers/:id/history')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.RUTAS_VER)
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

  @Post('backfill')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Backfill de histórico del proveedor (información anterior) a vehicle_positions' })
  backfill(@Query('from') from: string, @Query('to') to: string) {
    return this.service.backfillHistory(from, to);
  }

  @Post('bootstrap-vehicles')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Crear vehículos desde los trackers sin vincular (por placa)' })
  bootstrapVehicles() {
    return this.service.bootstrapVehicles();
  }

  @Post('sync-routes')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_GESTIONAR, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Sync autoritativo ruta↔operador↔camión desde la API oficial (travels/operators)' })
  syncRoutes() {
    return this.service.syncRoutesOperators();
  }

  @Patch('trackers/:id/link')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Vincular/desvincular un tracker a un vehículo' })
  link(@Param('id') id: string, @Body() body: { vehicle_id: string | null }) {
    return this.service.linkTracker(id, body?.vehicle_id ?? null);
  }

  @Patch('trackers/:id/route')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_GESTIONAR, Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Asignar manualmente la ruta de un tracker (null = automático)' })
  setRoute(@Param('id') id: string, @Body() body: { route_number: number | null }) {
    return this.service.setRoute(id, body?.route_number ?? null);
  }
}
