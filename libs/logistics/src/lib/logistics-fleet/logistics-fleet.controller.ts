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
  LogisticsFleetService,
  CreateVehicleDto,
  UpdateVehicleDto,
  CreateDriverDto,
  UpdateDriverDto,
  DriverRole,
} from './logistics-fleet.service';

@ApiTags('logistics-fleet')
@Controller('logistics/fleet')
export class LogisticsFleetController {
  constructor(private readonly service: LogisticsFleetService) {}

  // ── Vehicles ─────────────────────────────────────────────────────────────

  @Post('vehicles')
  @ApiOperation({ summary: 'Crear vehicle' })
  createVehicle(@Body() body: CreateVehicleDto) {
    return this.service.createVehicle(body);
  }

  @Get('vehicles')
  @ApiOperation({ summary: 'Listar vehicles del tenant' })
  listVehicles(@Query('active') active?: string, @Query('status') status?: string) {
    return this.service.listVehicles({
      active: active === undefined ? undefined : active === 'true',
      status,
    });
  }

  @Get('vehicles/:id')
  @ApiOperation({ summary: 'Obtener vehicle por id' })
  findVehicle(@Param('id') id: string) {
    return this.service.findVehicle(id);
  }

  @Patch('vehicles/:id')
  @ApiOperation({ summary: 'Actualizar vehicle (parcial)' })
  updateVehicle(@Param('id') id: string, @Body() body: UpdateVehicleDto) {
    return this.service.updateVehicle(id, body);
  }

  @Delete('vehicles/:id')
  @ApiOperation({ summary: 'Soft-delete vehicle' })
  removeVehicle(@Param('id') id: string) {
    return this.service.softDeleteVehicle(id);
  }

  // ── Drivers ──────────────────────────────────────────────────────────────

  @Post('drivers')
  @ApiOperation({ summary: 'Crear driver (chofer/ayudante/cargador)' })
  createDriver(@Body() body: CreateDriverDto) {
    return this.service.createDriver(body);
  }

  @Get('drivers')
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
  @ApiOperation({ summary: 'Obtener driver por id' })
  findDriver(@Param('id') id: string) {
    return this.service.findDriver(id);
  }

  @Patch('drivers/:id')
  @ApiOperation({ summary: 'Actualizar driver (parcial)' })
  updateDriver(@Param('id') id: string, @Body() body: UpdateDriverDto) {
    return this.service.updateDriver(id, body);
  }

  @Delete('drivers/:id')
  @ApiOperation({ summary: 'Soft-delete driver' })
  removeDriver(@Param('id') id: string) {
    return this.service.softDeleteDriver(id);
  }

  // ── J.9.9 — Vehicle usage logs (check-in / check-out) ───────────────────

  @Post('usage/check-in')
  @ApiOperation({ summary: 'J.9.9: registrar salida de vehicle (con km inicial + driver opcional)' })
  checkIn(@Body() body: { vehicle_id: string; driver_id?: string; shipment_id?: string; check_in_km: number; check_in_notes?: string }) {
    return this.service.checkInVehicle(body);
  }

  @Post('usage/:id/check-out')
  @ApiOperation({ summary: 'J.9.9: registrar regreso de vehicle (con km final + combustible)' })
  checkOut(@Param('id') id: string, @Body() body: { check_out_km: number; fuel_loaded_liters?: number; check_out_notes?: string }) {
    return this.service.checkOutVehicle(id, body);
  }

  @Get('usage')
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
  @ApiOperation({ summary: 'J.9.9: registrar mantenimiento (preventivo|correctivo|inspeccion)' })
  createMaintenance(@Body() body: any) {
    return this.service.createMaintenance(body);
  }

  @Get('maintenance/due')
  @ApiOperation({ summary: 'J12.6: vehículos con servicio vencido (odómetro ≥ next_service_km o fecha)' })
  maintenanceDue() {
    return this.service.maintenanceDue();
  }

  @Get('fuel-efficiency')
  @ApiOperation({ summary: 'J12.6: rendimiento real km/l por unidad vs spec (detecta fugas)' })
  fuelEfficiency() {
    return this.service.fuelEfficiency();
  }

  @Get('vehicles/:id/odometer')
  @ApiOperation({ summary: 'Odómetro actual de la unidad (para autollenar km de check-in/servicio)' })
  vehicleOdometer(@Param('id') id: string) {
    return this.service.vehicleOdometer(id);
  }

  @Get('maintenance')
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
  @ApiOperation({ summary: 'J.9.9: soft-delete mantenimiento' })
  removeMaintenance(@Param('id') id: string) {
    return this.service.softDeleteMaintenance(id);
  }
}
