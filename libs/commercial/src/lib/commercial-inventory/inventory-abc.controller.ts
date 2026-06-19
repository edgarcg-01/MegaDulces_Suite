import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { InventoryAbcService } from './inventory-abc.service';
import { CycleCountSchedulerService } from './cycle-count-scheduler.service';
import { RolesGuard, RequirePermissions, Permission, TenantContextService } from '@megadulces/platform-core';

@ApiTags('commercial-inventory-abc')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/abc')
export class InventoryAbcController {
  constructor(
    private readonly service: InventoryAbcService,
    private readonly scheduler: CycleCountSchedulerService,
    private readonly tenantCtx: TenantContextService,
  ) {}

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

  @Get('cycle-due')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary:
      'Qué toca contar (conteo cíclico): ABC × historial reconciliado → next_due por cadencia de clase (?warehouse_id=&abc_class=&only_due=false) — ABC.1',
  })
  cycleDue(
    @Query('warehouse_id') warehouseId?: string,
    @Query('abc_class') abcClass?: string,
    @Query('only_due') onlyDue?: string,
  ) {
    return this.service.cycleDue({
      warehouse_id: warehouseId,
      abc_class: abcClass,
      only_due: onlyDue === 'false' ? false : true,
    });
  }

  @Post('generate-cycle-folios')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary:
      'Genera folios cíclicos de lo que toca contar (scoped al tenant del JWT; opcional warehouse_id). Disparo manual del scheduler — ABC.3',
  })
  generateCycleFolios(@Body() body?: { warehouse_id?: string; max_items?: number }) {
    return this.scheduler.generateForTenant(this.tenantCtx.requireTenantId(), {
      warehouseId: body?.warehouse_id,
      maxItemsPerFolio: body?.max_items,
    });
  }
}
