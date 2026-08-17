import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { InventoryRiskService } from './inventory-risk.service';

/**
 * Fase PREV.3 — Índice de riesgo de inventario (Apéndice B). Ver = COMMERCIAL_PREVENTION_VER,
 * recalcular = COMMERCIAL_PREVENTION_GESTIONAR.
 */
@ApiTags('commercial-inventory')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/risk')
export class InventoryRiskController {
  constructor(private readonly service: InventoryRiskService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_VER)
  @ApiOperation({ summary: 'Índice de riesgo por (almacén,producto), ordenado por score (?risk_level=&warehouse_id=)' })
  list(
    @Query('risk_level') riskLevel?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({ risk_level: riskLevel, warehouse_id: warehouseId, limit: limit ? Number(limit) : undefined });
  }

  @Post('compute')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Recalcular el índice de riesgo (ventana 90d) — todo o por almacén' })
  compute(@Body() body: { warehouse_id?: string }) {
    return this.service.compute(body?.warehouse_id);
  }
}
