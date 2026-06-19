import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { InventoryAbcService } from './inventory-abc.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

@ApiTags('commercial-inventory-abc')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/abc')
export class InventoryAbcController {
  constructor(private readonly service: InventoryAbcService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Clasificación ABC vigente por (almacén, producto) (?warehouse_id=&abc_class=A|B|C) — ABC.0' })
  list(
    @Query('warehouse_id') warehouseId?: string,
    @Query('abc_class') abcClass?: string,
  ) {
    return this.service.listAbc({ warehouse_id: warehouseId, abc_class: abcClass });
  }

  @Post('refresh')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Recomputa la clasificación ABC del tenant (?window_days=90) — ABC.0' })
  refresh(@Body() body?: { window_days?: number }, @Query('window_days') windowDays?: string) {
    return this.service.computeAbc({
      window_days: body?.window_days ?? (windowDays != null ? Number(windowDays) : undefined),
    });
  }
}
