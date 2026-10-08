import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAuthGuard, RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { CreateWarehouseLocationBody, WarehouseLocationRow, WarehouseLocationsResponse } from '@megadulces/contracts';
import { WarehouseLocationsService } from './warehouse-locations.service';

/**
 * `[UB.1]` Catálogo de ubicaciones (Fase UB, ADR-090) — pantalla `/almacen/ubicaciones`.
 *
 * Permisos PROPIOS (`ALMACEN_UBICACIONES_*`, repartidos por la migración 20261008011555), no los
 * de inventario: ver el comentario en `permissions.ts`. Los endpoints de WMS-REC
 * (`/commercial/inventory/bins`, put-away, move-lot) siguen con sus permisos de siempre para no
 * romperle el Andén a nadie; se migran cuando el acomodo pase a este módulo (`[UB.5]`).
 */
@ApiTags('warehouse-locations')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/locations')
export class WarehouseLocationsController {
  constructor(private readonly svc: WarehouseLocationsService) {}

  @Get()
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_VER)
  @ApiOperation({ summary: 'Ubicaciones de un almacén (?warehouse_id=, default el primero visible) + resumen y alcance.' })
  list(@Query('warehouse_id') warehouseId?: string): Promise<WarehouseLocationsResponse> {
    return this.svc.list(warehouseId);
  }

  @Post()
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Dar de alta UNA ubicación con el código [T|B][pasillo][rack 01-99][nivel 1-6].' })
  create(@Body() body: CreateWarehouseLocationBody): Promise<WarehouseLocationRow> {
    return this.svc.create(body);
  }
}
