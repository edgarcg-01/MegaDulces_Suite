import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { InventoryVarianceService } from './inventory-variance.service';
import { InventoryCountPlanService } from './inventory-count-plan.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

/**
 * [IC.0] Diferencias del conteo físico de Kepler.
 *
 * Gate `COMMERCIAL_INVENTORY_VER`: es lectura, y ese permiso **ya está repartido** a 10 roles
 * y 29 usuarios activos (compras, dirección, encargado de tienda, prevención, supervisor…).
 * Crear un permiso nuevo habría repetido el error de [LC.6.2] — una clave declarada en el
 * enum que nadie tiene, o sea un módulo en prod que no puede abrir ni una persona.
 */
@ApiTags('commercial-inventory-variance')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/variance')
export class InventoryVarianceController {
  constructor(
    private readonly service: InventoryVarianceService,
    private readonly plan: InventoryCountPlanService,
  ) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Descuadre por evento de conteo (almacén × fecha). '
      + 'Excluye cargas iniciales salvo ?include_initial_load=true — una migración de ERP no es un descuadre.',
  })
  summary(
    @Query('warehouse_id') warehouseId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('include_initial_load') includeInitialLoad?: string,
  ) {
    return this.service.summary({
      warehouse_id: warehouseId,
      date_from: dateFrom,
      date_to: dateTo,
      include_initial_load: includeInitialLoad === 'true',
    });
  }

  @Get('events')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Almacenes y fechas con conteo — para poblar filtros sin adivinar' })
  events() {
    return this.service.events();
  }

  @Get('coverage')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Cobertura del conteo: cuántos SKUs con existencia quedaron SIN contar. '
      + 'Sin esto el tablero miente por omisión.',
  })
  coverage(
    @Query('warehouse_id') warehouseId: string,
    @Query('fecha') fecha: string,
  ) {
    return this.service.coverage({ warehouse_id: warehouseId, fecha });
  }

  // ── [IC.5] El plan del mes ───────────────────────────────────────────────────────────
  @Get('plan')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary: 'Qué contar este mes: la ola rotativa (un tercio del catálogo) + el top. '
      + 'La ola sale del mes salvo que se pase ?ola=1|2|3.',
  })
  monthlyPlan(
    @Query('warehouse_id') warehouseId: string,
    @Query('ola') ola?: string,
    @Query('top_n') topN?: string,
    @Query('limit') limit?: string,
  ) {
    return this.plan.monthlyPlan({
      warehouse_id: warehouseId,
      ola: ola ? Number(ola) : undefined,
      top_n: topN ? Number(topN) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('plan/coverage')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary: 'Las 3 olas, ¿cubren TODO el catálogo? Si una quedara vacía, un tercio no se '
      + 'contaría nunca y cada mes el plan se vería normal.',
  })
  waveCoverage(@Query('warehouse_id') warehouseId: string) {
    return this.plan.waveCoverage(warehouseId);
  }

  @Get('detail')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Detalle SKU por SKU de un evento — la lista accionable' })
  detail(
    @Query('warehouse_id') warehouseId: string,
    @Query('fecha') fecha: string,
    @Query('signo') signo?: 'sobrante' | 'faltante',
    @Query('limit') limit?: string,
  ) {
    return this.service.detail({
      warehouse_id: warehouseId,
      fecha,
      signo,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
