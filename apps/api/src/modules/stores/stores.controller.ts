import { Controller, Get, Post, Put, Body, Param, UseGuards } from '@nestjs/common';
import { StoresService } from './stores.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('stores')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get()
  @ApiOperation({ summary: 'Lista completa de todos los PDV activos para el dispositivo móvil' })
  findAll() {
    return this.storesService.findAll();
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('superadmin')
  @ApiOperation({ summary: 'Superadmin: Crear nueva tienda o supermercado' })
  create(@Body() body: any) {
    return this.storesService.create(body);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('superadmin')
  @ApiOperation({ summary: 'Superadmin: Actualizar metadata física del Local' })
  update(@Param('id') id: string, @Body() body: any) {
    return this.storesService.update(id, body);
  }
}
