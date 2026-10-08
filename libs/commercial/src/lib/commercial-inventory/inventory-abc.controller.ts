import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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
  @ApiOperation({ summary: 'Clasificación ABC vigente por (almacén, producto) (?warehouse_id=&abc_class=A|B|C&limit=). [ABC.6] Devuelve { items, total, truncado, criterio } — antes era un array con LIMIT 2000 mudo — y cada fila trae `motivo_clase`: una C sin demanda NO es de bajo valor, es no medida.' })
  list(
    @Query('warehouse_id') warehouseId?: string,
    @Query('abc_class') abcClass?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listAbc({
      warehouse_id: warehouseId, abc_class: abcClass,
      limit: limit != null ? Number(limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Resumen ABC para KPIs: conteo+valor por clase, total, computed_at (?warehouse_id=)' })
  summary(@Query('warehouse_id') warehouseId?: string) {
    return this.service.summary({ warehouse_id: warehouseId });
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
      'Qué toca contar (conteo cíclico): ABC × historial reconciliado → next_due por cadencia de clase (?warehouse_id=&abc_class=&only_due=false&limit=) — ABC.1. [ABC.6] `by_class` se cuenta sobre TODO el universo y no sobre la página: contarlo después del LIMIT publicaba «A 2000 · B 0 · C 0» con 6,822 B y 27,671 C vencidas esperando.',
  })
  cycleDue(
    @Query('warehouse_id') warehouseId?: string,
    @Query('abc_class') abcClass?: string,
    @Query('only_due') onlyDue?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.cycleDue({
      warehouse_id: warehouseId,
      abc_class: abcClass,
      only_due: onlyDue === 'false' ? false : true,
      limit: limit != null ? Number(limit) : undefined,
    });
  }

  @Get('seleccion')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary:
      '[IC.24] La SELECCIÓN del conteo con el porqué de cada producto '
      + '(?warehouse_id=&ritmo=diario|mensual&dias_cobertura=&limit=). El motor es el HECHO DE '
      + 'VENTA (sales_daily.cost, COGS real 30d), no v_count_priority_score: medido, el score '
      + 'cubre 5.5% del COGS con 4× el esfuerzo. Devuelve además el ESFUERZO en piezas (no en '
      + 'renglones) y la COBERTURA del dinero diario. El tiempo estimado se declara NO MEDIDO: '
      + 'piezas por hora por persona no existe porque nunca se cerró un folio.',
  })
  seleccion(
    @Query('warehouse_id') warehouseId: string,
    @Query('ritmo') ritmo?: string,
    @Query('dias_cobertura') diasCobertura?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.countSelection({
      warehouse_id: warehouseId,
      ritmo: ritmo === 'mensual' ? 'mensual' : 'diario',
      // 'off' apaga el filtro de velocidad a propósito; vacío deja el default del ritmo.
      dias_cobertura: diasCobertura === 'off' ? null : (diasCobertura != null ? Number(diasCobertura) : undefined),
      limit: limit != null ? Number(limit) : undefined,
    });
  }

  @Get('seleccion/:product_id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary:
      '[IC.24] El porqué PROFUNDO de un SKU: historia de conteos (de la matvista de señales, con '
      + '`explicacion`) y su capital. Va aparte de la lista por costo medido: en la lista serían '
      + '1,083 ms porque esas vistas calculan su partición entera aunque se filtre por producto.',
  })
  seleccionDetalle(
    @Param('product_id') productId: string,
    @Query('warehouse_id') warehouseId: string,
  ) {
    return this.service.countSelectionDetail({
      warehouse_id: warehouseId,
      product_id: productId,
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
