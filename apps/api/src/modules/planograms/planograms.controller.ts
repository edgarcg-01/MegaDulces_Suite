import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { PlanogramsService } from './planograms.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('planograms')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('planograms/brands')
export class PlanogramsController {
  constructor(private readonly planogramsService: PlanogramsService) {}

  @Get()
  @ApiOperation({
    summary: 'Obtiene todo el catálogo jerárquico de Marcas y Productos',
  })
  async getAll() {
    return this.planogramsService.getAll();
  }

  @Post()
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Crea una nueva marca' })
  async createBrand(@Body() body: any) {
    return this.planogramsService.createBrand(body);
  }

  @Post(':id/products')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Crea un producto bajo una marca existente' })
  async addProduct(@Param('id') id: string, @Body() body: any) {
    return this.planogramsService.addProduct(id, body);
  }

  @Put(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar datos de una marca' })
  async updateBrand(@Param('id') id: string, @Body() body: any) {
    return this.planogramsService.updateBrand(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Borra una marca' })
  async deleteBrand(@Param('id') id: string) {
    return this.planogramsService.deleteBrand(id);
  }
}

@ApiTags('planograms')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('planograms/products')
export class PlanogramsProductsController {
  constructor(private readonly planogramsService: PlanogramsService) {}

  @Put(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Actualiza datos de un producto' })
  async updateProduct(@Param('id') id: string, @Body() body: any) {
    return this.planogramsService.updateProduct(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({ summary: 'Borra un producto' })
  async deleteProduct(@Param('id') id: string) {
    return this.planogramsService.deleteProduct(id);
  }
}
