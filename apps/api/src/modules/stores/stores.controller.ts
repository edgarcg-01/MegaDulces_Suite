import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { StoresService } from './stores.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('stores')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get('nearby')
  @ApiOperation({ summary: 'Buscar tiendas cercanas por GPS' })
  findNearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radius?: string,
  ) {
    return this.storesService.findNearby(
      parseFloat(lat),
      parseFloat(lng),
      radius ? parseFloat(radius) : 50,
    );
  }

  @Get()
  @ApiOperation({
    summary:
      'Lista completa de todos los PDV activos para el dispositivo móvil',
  })
  findAll(@Query('zona_id') zona_id?: string, @Query('ruta_id') ruta_id?: string) {
    return this.storesService.findAll(zona_id, ruta_id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @RequirePermissions(Permission.TIENDAS_CREAR)
  @ApiOperation({ summary: 'Crear nueva tienda o supermercado' })
  create(@Body() body: any) {
    return this.storesService.create(body);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @RequirePermissions(Permission.CATALOGO_GESTIONAR)
  @ApiOperation({ summary: 'Eliminar tienda o punto de venta' })
  remove(@Param('id') id: string) {
    return this.storesService.remove(id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @RequirePermissions(Permission.CATALOGO_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar metadata física del Local' })
  update(@Param('id') id: string, @Body() body: any) {
    return this.storesService.update(id, body);
  }
}
