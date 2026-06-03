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
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

/**
 * Admin de products. Gateado por CATALOGO_GESTIONAR — exponemos cost_base
 * (sensible) que NO debe ver customer_b2b. Vendedor también queda fuera.
 */
@ApiTags('commercial-products')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/products')
export class CommercialProductsController {
  constructor(private readonly service: CommercialProductsService) {}

  @Get()
  @RequirePermissions(Permission.CATALOGO_GESTIONAR)
  @ApiOperation({
    summary:
      'Listar productos (paginado + filtros). Incluye costs/location/loyalty del importer Mega_Dulces.',
  })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('brand_id') brandId?: string,
    @Query('category_id') categoryId?: string,
    @Query('active') active?: string,
    @Query('with_cost') withCost?: string,
  ) {
    return this.service.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      brand_id: brandId,
      category_id: categoryId,
      active: active === undefined ? undefined : active === 'true',
      with_cost: withCost === 'true',
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.CATALOGO_GESTIONAR)
  @ApiOperation({
    summary: 'Detalle de producto + counts agregados (price configs, stock total)',
  })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.CATALOGO_GESTIONAR)
  @ApiOperation({
    summary:
      'Editar campos manuales del producto (description, location, loyalty_points, activo). NO permite tocar costos/precios/SKU — esos vienen del ERP.',
  })
  update(@Param('id') id: string, @Body() body: UpdateProductDto) {
    return this.service.update(id, body);
  }
}
