import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  CommercialWarehousesService,
  CreateWarehouseDto,
  UpdateWarehouseDto,
} from './commercial-warehouses.service';

@ApiTags('commercial-warehouses')
@Controller('commercial/warehouses')
export class CommercialWarehousesController {
  constructor(private readonly service: CommercialWarehousesService) {}

  @Post()
  @ApiOperation({ summary: 'Crear warehouse' })
  create(@Body() body: CreateWarehouseDto) {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar warehouses del tenant' })
  list(@Query('active') active?: string) {
    return this.service.list({
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener warehouse por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar warehouse (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdateWarehouseDto) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete warehouse' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
