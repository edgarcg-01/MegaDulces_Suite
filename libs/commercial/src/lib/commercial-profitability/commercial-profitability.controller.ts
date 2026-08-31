import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import {
  CommercialProfitabilityService,
  type MarginBand,
  type MarginLevel,
  type MarginWindow,
} from './commercial-profitability.service';

@ApiTags('commercial-profitability')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/profitability')
export class CommercialProfitabilityController {
  constructor(private readonly service: CommercialProfitabilityService) {}

  @Get('overview')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Cascada de margen — resumen. Venta real (sell-out product_sales_stats, NO order_lines) vs costo, brecha vs objetivo, bandas de salud, capital en inventario y cobertura (qué % de la venta tiene costo con qué juzgarla).',
  })
  overview(@Query('window') window?: string, @Query('target') target?: string) {
    return this.service.overview({
      window: window as MarginWindow,
      target: target ? Number(target) : undefined,
    });
  }

  @Get('breakdown')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Desglose por proveedor / marca / categoría / SKU / sucursal / canal con margen bruto, brecha en pp y en pesos, inventario, GMROI y contribución anual. Mismo cálculo en los 6 niveles. A nivel SKU agrega el margen POR UNIDAD (precio − costo en la unidad que cobra el PdV) y la equivalencia por caja. `warehouse` y `channel` suben el grano del fact: el inventario se une al mismo grano (por canal no existe y se declara en cero).',
  })
  breakdown(
    @Query('window') window?: string,
    @Query('level') level?: string,
    @Query('target') target?: string,
    @Query('search') search?: string,
    @Query('band') band?: string,
    @Query('supplier_id') supplierId?: string,
    @Query('brand_id') brandId?: string,
    @Query('category_id') categoryId?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('channel') channel?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ) {
    return this.service.breakdown({
      window: window as MarginWindow,
      level: level as MarginLevel,
      target: target ? Number(target) : undefined,
      search,
      band: band as MarginBand,
      supplierId,
      brandId,
      categoryId,
      warehouseId,
      channel,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      sort,
      dir: dir === 'asc' ? 'asc' : 'desc',
    });
  }

  @Get('supplier/:id/levers')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Palancas negociadas de un proveedor en puntos porcentuales sobre su venta: notas de crédito (X-D-55/X-D-40), descuento tomado al pagar (c84) y política pactada. Incluye `not_attributed`: lo que todavía no se puede repartir a SKU.',
  })
  supplierLevers(@Param('id') id: string, @Query('window') window?: string, @Query('target') target?: string) {
    return this.service.supplierLevers(id, {
      window: window as MarginWindow,
      target: target ? Number(target) : undefined,
    });
  }
}
