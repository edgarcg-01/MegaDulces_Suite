import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  WarehouseAislesService,
  CreateAisleDto,
  UpdateAisleDto,
  AssignSkusDto,
} from './warehouse-aisles.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

@ApiTags('commercial-inventory-aisles')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/aisles')
export class WarehouseAislesController {
  constructor(private readonly service: WarehouseAislesService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Pasillos 2D del almacén + carga (unidades/#SKUs) + bucket "Sin pasillo" (?warehouse_id=) — PA.1' })
  list(@Query('warehouse_id') warehouseId: string) {
    return this.service.listAisles(warehouseId);
  }

  @Get('brands')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Marcas con stock en el almacén (dropdown de asignación bulk) (?warehouse_id=) — PA.1' })
  brands(@Query('warehouse_id') warehouseId: string) {
    return this.service.brandsInWarehouse(warehouseId);
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Crear pasillo (posición 2D en grilla) — PA.1' })
  create(@Body() body: CreateAisleDto) {
    return this.service.createAisle(body);
  }

  @Patch(':id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Editar pasillo (nombre/posición/activo) — PA.1' })
  update(@Param('id') id: string, @Body() body: UpdateAisleDto) {
    return this.service.updateAisle(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Borrar pasillo (SET NULL en stock; bloqueado si un folio abierto lo usa) — PA.1' })
  remove(@Param('id') id: string) {
    return this.service.deleteAisle(id);
  }

  @Post('assign')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({
    summary:
      'Mapeo bulk SKU→pasillo por filtro (product_ids / brand_id / abc_class / rango SKU / only_unassigned). aisle_id=null des-asigna — PA.1',
  })
  assign(@Body() body: AssignSkusDto) {
    return this.service.assignSkus(body);
  }
}
