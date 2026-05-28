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
  LogisticsConfigService,
  CreateConfigDto,
  UpdateConfigDto,
  ConfigCategory,
} from './logistics-config.service';

@ApiTags('logistics-config')
@Controller('logistics/config')
export class LogisticsConfigController {
  constructor(private readonly service: LogisticsConfigService) {}

  @Post()
  @ApiOperation({ summary: 'Crear config_finance' })
  create(@Body() body: CreateConfigDto) {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar config_finance del tenant' })
  list(@Query('category') category?: ConfigCategory, @Query('active') active?: string) {
    return this.service.list({
      category,
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener config por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar config (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdateConfigDto) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Hard-delete config (no soft-delete: poco data y se reemplaza)' })
  remove(@Param('id') id: string) {
    return this.service.delete(id);
  }

  // ── J.9.8 — Routes CRUD (Comisiones por ruta del catálogo destinos) ────
  @Get('routes/list')
  @ApiOperation({ summary: 'J.9.8: listar routes (96 destinos reales del importer baseline)' })
  listRoutes(@Query('active') active?: string, @Query('search') search?: string) {
    return this.service.listRoutes({
      active: active === undefined ? undefined : active === 'true',
      search: search || undefined,
    });
  }

  @Post('routes')
  @ApiOperation({ summary: 'J.9.8: crear route con comisiones' })
  createRoute(@Body() body: any) {
    return this.service.createRoute(body);
  }

  @Patch('routes/:id')
  @ApiOperation({ summary: 'J.9.8: actualizar route (parcial)' })
  updateRoute(@Param('id') id: string, @Body() body: any) {
    return this.service.updateRoute(id, body);
  }

  @Delete('routes/:id')
  @ApiOperation({ summary: 'J.9.8: soft-delete route' })
  deleteRoute(@Param('id') id: string) {
    return this.service.deleteRoute(id);
  }
}
