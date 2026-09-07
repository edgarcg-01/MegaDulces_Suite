import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  Permission,
  RequireAnyPermission,
  RequirePermissions,
} from '@megadulces/platform-core';
import {
  LogisticsFleetService,
  CreateVehicleDto,
  UpdateVehicleDto,
  CreateDriverDto,
  UpdateDriverDto,
  DriverRole,
} from './logistics-fleet.service';

/**
 * `[AUTHZ.5]` — Este controller no tenía **ningún** decorador de autorización, ni de clase ni de
 * método. Como `RolesGuard` es global pero **no-op** en rutas sin `@RequirePermissions`, cualquier
 * usuario autenticado podía crear, editar y **borrar** unidades, choferes, mantenimientos y cargas
 * de combustible. La autorización de flota vivía sólo en el `permissionGuard` del frontend.
 *
 * Los permisos ya existían y **ya estaban repartidos** en prod (`finanzas` + `superadmin`); lo que
 * faltaba era exigirlos. Regla: `_VER` para leer, `_GESTIONAR` para escribir.
 */
@ApiTags('logistics-fleet')
@Controller('logistics/fleet')
export class LogisticsFleetController {
  constructor(private readonly service: LogisticsFleetService) {}

  // ── Vehicles ─────────────────────────────────────────────────────────────

  @Post('vehicles')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Crear vehicle' })
  createVehicle(@Body() body: CreateVehicleDto) {
    return this.service.createVehicle(body);
  }

  /**
   * OR medido, no de precaución: `/reparto` (home-delivery) llama a esta ruta para elegir la moto,
   * y sus usuarios —`encargado_tienda` (6) y `auxiliar_tienda` (3)— **no tienen** `FLEET_VER`.
   * Gatearla sólo con `FLEET_VER` dejaba a 9 personas sin poder despachar.
   */
  @Get('vehicles')
  @RequireAnyPermission(Permission.LOGISTICS_FLEET_VER, Permission.REPARTO_DESPACHAR)
  @ApiOperation({ summary: 'Listar vehicles del tenant' })
  listVehicles(@Query('active') active?: string, @Query('status') status?: string) {
    return this.service.listVehicles({
      active: active === undefined ? undefined : active === 'true',
      status,
    });
  }

  @Get('vehicles/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Obtener vehicle por id' })
  findVehicle(@Param('id') id: string) {
    return this.service.findVehicle(id);
  }

  @Patch('vehicles/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar vehicle (parcial)' })
  updateVehicle(@Param('id') id: string, @Body() body: UpdateVehicleDto) {
    return this.service.updateVehicle(id, body);
  }

  @Delete('vehicles/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete vehicle' })
  removeVehicle(@Param('id') id: string) {
    return this.service.softDeleteVehicle(id);
  }

  // ── Drivers ──────────────────────────────────────────────────────────────

  @Post('drivers')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Crear driver (chofer/ayudante/cargador)' })
  createDriver(@Body() body: CreateDriverDto) {
    return this.service.createDriver(body);
  }

  @Get('drivers')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Listar drivers del tenant' })
  listDrivers(
    @Query('active') active?: string,
    @Query('role') role?: DriverRole,
    @Query('search') search?: string,
  ) {
    return this.service.listDrivers({
      active: active === undefined ? undefined : active === 'true',
      role,
      search,
    });
  }

  @Get('drivers/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Obtener driver por id' })
  findDriver(@Param('id') id: string) {
    return this.service.findDriver(id);
  }

  @Patch('drivers/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar driver (parcial)' })
  updateDriver(@Param('id') id: string, @Body() body: UpdateDriverDto) {
    return this.service.updateDriver(id, body);
  }

  @Delete('drivers/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete driver' })
  removeDriver(@Param('id') id: string) {
    return this.service.softDeleteDriver(id);
  }

  // ── J.9.9 — Vehicle usage logs (check-in / check-out) ───────────────────

  @Post('usage/check-in')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'J.9.9: registrar salida de vehicle (con km inicial + driver opcional)' })
  checkIn(@Body() body: { vehicle_id: string; driver_id?: string; shipment_id?: string; check_in_km: number; check_in_notes?: string }) {
    return this.service.checkInVehicle(body);
  }

  @Post('usage/:id/check-out')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'J.9.9: registrar regreso de vehicle (con km final + combustible)' })
  checkOut(@Param('id') id: string, @Body() body: { check_out_km: number; fuel_loaded_liters?: number; check_out_notes?: string }) {
    return this.service.checkOutVehicle(id, body);
  }

  @Get('usage')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'J.9.9: lista historial de uso (filtros vehicle_id + status)' })
  listUsage(
    @Query('vehicle_id') vehicle_id?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listVehicleUsage({
      vehicle_id, status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── J.9.9 — Vehicle maintenance log ─────────────────────────────────────

  @Post('maintenance')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'J.9.9: registrar mantenimiento (preventivo|correctivo|inspeccion)' })
  createMaintenance(@Body() body: any) {
    return this.service.createMaintenance(body);
  }

  @Get('maintenance/due')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'J12.6: vehículos con servicio vencido (odómetro ≥ next_service_km o fecha)' })
  maintenanceDue() {
    return this.service.maintenanceDue();
  }

  @Get('fuel-efficiency')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'J12.6: rendimiento real km/l por unidad vs spec (detecta fugas)' })
  fuelEfficiency() {
    return this.service.fuelEfficiency();
  }

  @Get('vehicles/:id/odometer')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'Odómetro actual de la unidad (para autollenar km de check-in/servicio)' })
  vehicleOdometer(@Param('id') id: string) {
    return this.service.vehicleOdometer(id);
  }

  // ── J12.6 Cargas de combustible ──────────────────────────────────────────
  @Post('fuel')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'J12.6: registrar carga de combustible' })
  createFuel(@Body() body: any) {
    return this.service.createFuelTransaction(body);
  }

  @Get('fuel')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'J12.6: listar cargas de combustible' })
  listFuel(@Query('vehicle_id') vehicle_id?: string, @Query('limit') limit?: string) {
    return this.service.listFuelTransactions({ vehicle_id, limit: limit ? Number(limit) : undefined });
  }

  @Delete('fuel/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'J12.6: borrar carga de combustible' })
  deleteFuel(@Param('id') id: string) {
    return this.service.deleteFuelTransaction(id);
  }

  @Get('maintenance')
  @RequirePermissions(Permission.LOGISTICS_FLEET_VER)
  @ApiOperation({ summary: 'J.9.9: listar mantenimientos del vehicle / tipo' })
  listMaintenance(
    @Query('vehicle_id') vehicle_id?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listMaintenance({
      vehicle_id, type,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Delete('maintenance/:id')
  @RequirePermissions(Permission.LOGISTICS_FLEET_GESTIONAR)
  @ApiOperation({ summary: 'J.9.9: soft-delete mantenimiento' })
  removeMaintenance(@Param('id') id: string) {
    return this.service.softDeleteMaintenance(id);
  }
}
