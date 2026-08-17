import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { InventoryMonitoringService, StartMonitoringDto } from './inventory-monitoring.service';

/**
 * Fase PREV.2 — Monitoreo intensivo (Apéndice B). Ver = COMMERCIAL_PREVENTION_VER,
 * operar = COMMERCIAL_PREVENTION_GESTIONAR (mismo dueño que el expediente).
 */
@ApiTags('commercial-inventory')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/monitoring')
export class InventoryMonitoringController {
  constructor(private readonly service: InventoryMonitoringService) {}

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Iniciar monitoreo intensivo de un SKU (opcionalmente desde un expediente PNI)' })
  start(@Body() body: StartMonitoringDto) {
    return this.service.start(body);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_VER)
  @ApiOperation({ summary: 'Bandeja de monitoreos (?status=active|closed|all) + conteos de hoy + último faltante' })
  list(
    @Query('status') status?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({ status, warehouse_id: warehouseId, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_VER)
  @ApiOperation({ summary: 'Detalle del monitoreo + conteos con ventanas de pérdida' })
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Post(':id/count')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Registrar un conteo rápido (expected = stock del sistema; ventana desde el previo)' })
  recordCount(@Param('id') id: string, @Body() body: { physical_qty: number; notes?: string }) {
    return this.service.recordCount(id, body);
  }

  @Post(':id/close')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Cerrar el monitoreo' })
  close(@Param('id') id: string) {
    return this.service.close(id);
  }
}
