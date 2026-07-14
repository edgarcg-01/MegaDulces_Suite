import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { PlanogramsService } from './planograms.service';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { RequireAuthGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { RolesGuard } from '@megadulces/platform-core';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('planograms')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('planograms/brands')
export class PlanogramsController {
  constructor(private readonly planogramsService: PlanogramsService) {}

  @Get()
  @ApiOperation({
    summary: 'Obtiene todo el catálogo jerárquico de Marcas y Productos',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    description: 'Incluir marcas/productos soft-deleted (default: false)',
    type: Boolean,
  })
  @ApiQuery({
    name: 'planogramOnly',
    required: false,
    description:
      'Solo productos del planograma de trade (default: true). false = catálogo completo (ERP) para curación.',
    type: Boolean,
  })
  async getAll(
    @Query('includeInactive') includeInactive?: string,
    @Query('planogramOnly') planogramOnly?: string,
  ) {
    return this.planogramsService.getAll(
      includeInactive === 'true',
      planogramOnly !== 'false',
    );
  }

  @Get('version')
  @ApiOperation({
    summary: 'Obtiene la versión (última actualización) del planograma para cache',
  })
  async getVersion() {
    return this.planogramsService.getVersion();
  }

  @Post('match-skus')
  @ApiOperation({
    summary: 'Dado SKUs (del set activo ERP), devuelve [{sku, product_id}] de los que están en el planograma de trade.',
  })
  async matchSkus(@Body() body: { skus?: string[] }) {
    return this.planogramsService.matchPlanogramSkus(body?.skus || []);
  }

  @Post()
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Crea una nueva marca' })
  async createBrand(@Body() dto: CreateBrandDto) {
    return this.planogramsService.createBrand(dto);
  }

  @Post(':id/products')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Crea un producto bajo una marca existente' })
  async addProduct(@Param('id') id: string, @Body() dto: CreateProductDto) {
    return this.planogramsService.addProduct(id, dto);
  }

  @Put(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar datos de una marca' })
  async updateBrand(@Param('id') id: string, @Body() dto: UpdateBrandDto) {
    return this.planogramsService.updateBrand(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({
    summary:
      'Eliminar marca. Soft-delete automático si sus productos están en capturas históricas; hard-delete si no.',
  })
  async deleteBrand(@Param('id') id: string) {
    return this.planogramsService.deleteBrand(id);
  }
}

@ApiTags('planograms')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('planograms/products')
export class PlanogramsProductsController {
  constructor(private readonly planogramsService: PlanogramsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene un producto por ID' })
  async getProduct(@Param('id') id: string) {
    return this.planogramsService.getProduct(id);
  }

  @Put(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Actualiza datos de un producto' })
  async updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.planogramsService.updateProduct(id, dto);
  }

  @Patch(':id/planogram')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({
    summary: 'Agrega/quita el producto del planograma de trade (in_planogram).',
  })
  async setPlanogramMembership(
    @Param('id') id: string,
    @Body() body: { in_planogram?: boolean },
  ) {
    return this.planogramsService.setPlanogramMembership(
      id,
      body?.in_planogram === true,
    );
  }

  @Delete(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({
    summary:
      'Eliminar producto. Soft-delete automático si está en capturas históricas; hard-delete si no.',
  })
  async deleteProduct(@Param('id') id: string) {
    return this.planogramsService.deleteProduct(id);
  }
}
