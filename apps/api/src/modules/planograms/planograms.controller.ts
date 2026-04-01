import { Controller, Get, Post, Body, Param, Put, Delete, UseGuards } from '@nestjs/common';
import { PlanogramsService } from './planograms.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('planograms')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('planograms/brands')
export class PlanogramsController {
  constructor(private readonly planogramsService: PlanogramsService) {}

  @Get()
  @ApiOperation({ summary: 'Obtiene todo el catálogo jerárquico de Marcas y Productos' })
  async getAll() {
    return this.planogramsService.getAll();
  }

  @Post()
  @ApiOperation({ summary: 'Crea una nueva marca' })
  async createBrand(@Body() body: any) {
    return this.planogramsService.createBrand(body);
  }

  @Post(':id/products')
  @ApiOperation({ summary: 'Crea un producto bajo una marca existente' })
  async addProduct(@Param('id') id: string, @Body() body: any) {
    return this.planogramsService.addProduct(id, body);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualiza datos de una marca' })
  async updateBrand(@Param('id') id: string, @Body() body: any) {
    return this.planogramsService.updateBrand(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Borra una marca' })
  async deleteBrand(@Param('id') id: string) {
    return this.planogramsService.deleteBrand(id);
  }
}

@ApiTags('planograms')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('planograms/products')
export class PlanogramsProductsController {
  constructor(private readonly planogramsService: PlanogramsService) {}

  @Put(':id')
  @ApiOperation({ summary: 'Actualiza datos de un producto' })
  async updateProduct(@Param('id') id: string, @Body() body: any) {
    return this.planogramsService.updateProduct(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Borra un producto' })
  async deleteProduct(@Param('id') id: string) {
    return this.planogramsService.deleteProduct(id);
  }
}
