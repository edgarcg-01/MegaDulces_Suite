import { Controller, Get, Post, Delete, Put, Body, Param, UseGuards } from '@nestjs/common';
import { CatalogsService } from './catalogs.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';

@ApiTags('catalogs')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('catalogs')
export class CatalogsController {
  constructor(private readonly catalogsService: CatalogsService) {}

  @Get(':type')
  @ApiOperation({ summary: 'Obtener un catálogo estructurado (ej. zonas, periodos, semanas, roles)' })
  @ApiParam({ name: 'type', description: 'El catálogo que deseas consumir' })
  getByType(@Param('type') type: string) {
    return this.catalogsService.getByType(type);
  }

  @Post(':type')
  @UseGuards(RolesGuard)
  @Roles('superadmin')
  @ApiOperation({ summary: 'Añadir un ítem dinámico nuevo al tipo de catálogo definido' })
  create(@Param('type') type: string, @Body() body: { value: string; orden?: number }) {
    return this.catalogsService.create(type, body);
  }

  @Delete(':type/:id')
  @UseGuards(RolesGuard)
  @Roles('superadmin')
  @ApiOperation({ summary: 'Eliminar el nodo de un catálogo usando su ID primario UUID' })
  deleteItem(@Param('type') type: string, @Param('id') id: string) {
    return this.catalogsService.delete(type, id);
  }

  @Put(':type/:id')
  @UseGuards(RolesGuard)
  @Roles('superadmin')
  @ApiOperation({ summary: 'Actualizar la información de un ítem de catálogo' })
  updateItem(@Param('type') type: string, @Param('id') id: string, @Body() body: any) {
    return this.catalogsService.update(type, id, body);
  }
}
