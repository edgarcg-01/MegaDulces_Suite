import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CommercialProductsService, UpdateProductDto } from './commercial-products.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions, RequireAnyPermission } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

/**
 * Admin de products. Reads gateados por COMMERCIAL_PRODUCTS_VER, mutaciones por
 * COMMERCIAL_PRODUCTS_GESTIONAR — exponemos cost_base (sensible) que NO debe ver
 * customer_b2b. Vendedor también queda fuera.
 */
@ApiTags('commercial-products')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/products')
export class CommercialProductsController {
  constructor(private readonly service: CommercialProductsService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PRODUCTS_VER)
  @ApiOperation({
    summary:
      'Listar productos (paginado + filtros). Incluye costs/location/loyalty del importer Mega_Dulces.',
  })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('brand_id') brandId?: string,
    @Query('brand_ids') brandIds?: string,
    @Query('category_id') categoryId?: string,
    @Query('supplier_id') supplierId?: string,
    @Query('active') active?: string,
    @Query('with_cost') withCost?: string,
    @Query('without_price') withoutPrice?: string,
  ) {
    return this.service.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      brand_id: brandId,
      brand_ids: brandIds ? brandIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      category_id: categoryId,
      supplier_id: supplierId,
      active: active === undefined ? undefined : active === 'true',
      with_cost: withCost === 'true',
      without_price: withoutPrice === 'true',
    });
  }

  @Get('duplicate-barcodes')
  @RequirePermissions(Permission.COMMERCIAL_PRODUCTS_VER)
  @ApiOperation({
    summary: 'Códigos de barras dados de alta en MÁS DE UN producto. No depende de que haya '
      + 'precios: el defecto vive en el catálogo de códigos y el precio sólo dice si además cobran '
      + 'distinto. `precios_disponibles` declara si ese contexto pudo calcularse.',
  })
  duplicateBarcodes(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.duplicateBarcodes({ search, limit: limit ? Number(limit) : undefined });
  }

  @Get('price-discrepancies')
  @RequirePermissions(Permission.COMMERCIAL_PRODUCTS_VER)
  @ApiOperation({
    summary: 'Productos cuyo precio al cliente NO es el mismo en todas las sucursales. Separa el '
      + 'precio de pieza del de mayoreo porque se corrigen en pantallas distintas de Kepler. '
      + '`comparable: false` = esta base no tiene el precio con grano por sucursal.',
  })
  priceDiscrepancies(
    @Query('search') search?: string,
    @Query('min_pct') minPct?: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.priceDiscrepancies({
      search,
      minPct: minPct ? Number(minPct) : undefined,
      kind: ['pieza','mayoreo','unidad'].includes(String(kind)) ? (kind as 'pieza'|'mayoreo'|'unidad') : '',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('heartbeat')
  @RequirePermissions(Permission.COMMERCIAL_PRODUCTS_VER)
  @ApiOperation({
    summary: 'El instante del último cambio de catálogo (códigos + precios). Consulta escalar: la '
      + 'pantalla la pide cada pocos segundos y sólo recarga cuando el valor se movió.',
  })
  heartbeat() {
    return this.service.catalogHeartbeat();
  }

  @Get('suppliers')
  // Lookup compartido: catálogo de productos + /comercial/salidas (filtro de proveedor).
  // Independencia de permisos entre features: basta VER productos O salidas.
  @RequireAnyPermission(Permission.COMMERCIAL_PRODUCTS_VER, Permission.COMMERCIAL_SALIDAS_VER)
  @ApiOperation({ summary: 'Proveedores con productos (id + nombre + # productos) para el filtro.' })
  suppliers() {
    return this.service.suppliers();
  }

  @Get('stats')
  @RequirePermissions(Permission.COMMERCIAL_PRODUCTS_VER)
  @ApiOperation({
    summary: 'Agregados catálogo-wide para KPIs (total/activos/con-costo/con-ubicación + top marcas). Honra search.',
  })
  stats(@Query('search') search?: string) {
    return this.service.stats(search);
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_PRODUCTS_VER)
  @ApiOperation({
    summary: 'Detalle de producto + counts agregados (price configs, stock total)',
  })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.COMMERCIAL_PRODUCTS_GESTIONAR)
  @ApiOperation({
    summary:
      'Editar campos manuales del producto (description, location, loyalty_points, activo). NO permite tocar costos/precios/SKU — esos vienen del ERP.',
  })
  update(@Param('id') id: string, @Body() body: UpdateProductDto) {
    return this.service.update(id, body);
  }
}
