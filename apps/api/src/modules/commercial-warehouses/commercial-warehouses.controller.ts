import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  CommercialWarehousesService,
  CreateWarehouseDto,
  UpdateWarehouseDto,
} from './commercial-warehouses.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

@ApiTags('commercial-warehouses')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/warehouses')
export class CommercialWarehousesController {
  constructor(private readonly service: CommercialWarehousesService) {}

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_WAREHOUSES_GESTIONAR)
  @ApiOperation({ summary: 'Crear warehouse' })
  create(@Body() body: CreateWarehouseDto) {
    return this.service.create(body);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_WAREHOUSES_VER)
  @ApiOperation({
    summary:
      'Listar warehouses del tenant. customer_b2b lo necesita para el portal (default warehouse del carrito) — la migración 20260601200000 le agrega WAREHOUSES_VER.',
  })
  list(@Query('active') active?: string) {
    return this.service.list({
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_WAREHOUSES_VER)
  @ApiOperation({ summary: 'Obtener warehouse por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.COMMERCIAL_WAREHOUSES_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar warehouse (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdateWarehouseDto) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.COMMERCIAL_WAREHOUSES_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete warehouse' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
