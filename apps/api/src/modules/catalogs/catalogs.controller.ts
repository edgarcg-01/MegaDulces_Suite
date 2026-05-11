import { Controller, Get, Post, Delete, Put, Body, Param, Query, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { CatalogsService } from './catalogs.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { createMongoAbility } from '@casl/ability';
import type { AppAbility } from '../../shared/ability/ability.types';

@ApiTags('catalogs')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('catalogs')
export class CatalogsController {
  constructor(private readonly catalogsService: CatalogsService) {}

  private checkCatalogManageAccess(req: any, type: string) {
    const ability = createMongoAbility<AppAbility>(req.user.rules || []);
    if (ability.can('manage', 'all')) return;

    if (['conceptos', 'ubicaciones', 'niveles'].includes(type)) {
      if (!ability.can('manage', 'scoring_config')) {
        throw new ForbiddenException('No tienes permisos suficientes para gestionar parámetros del scoring.');
      }
    } else {
      if (!ability.can('manage', 'catalogs')) {
        throw new ForbiddenException('No tienes permisos para gestionar catálogos maestros.');
      }
    }
  }

  @Get('permissions/:role_name')
  @RequirePermissions(Permission.ROLES_CONFIGURAR)
  @ApiOperation({
    summary: 'Obtener los permisos dinámicos (JSONB) de un rol específico',
  })
  getRolePermissions(@Param('role_name') roleName: string) {
    return this.catalogsService.getRolePermissions(roleName); 
  }

  @Put('permissions/:role_name')
  @RequirePermissions(Permission.ROLES_CONFIGURAR)
  @ApiOperation({
    summary: 'Actualizar los permisos dinámicos (JSONB) de un rol específico',
  })
  updateRolePermissions(
    @Param('role_name') roleName: string,
    @Body() body: any,
  ) {
    return this.catalogsService.updateRolePermissions(roleName, body);
  }

  @Get(':type')
  @ApiOperation({
    summary:
      'Obtener un catálogo estructurado (ej. zonas, periodos, semanas, roles)',
  })
  @ApiParam({ name: 'type', description: 'El catálogo que deseas consumir' })
  @ApiQuery({
    name: 'parent',
    required: false,
    description: 'Filtrar por ID del padre (ej. zona para obtener rutas)',
  })
  getByType(@Param('type') type: string, @Query('parent') parentId?: string) {
    return this.catalogsService.getByType(type, parentId);
  }

  @Post(':type')
  @ApiOperation({
    summary: 'Añadir un ítem dinámico nuevo al tipo de catálogo definido',
  })
  create(
    @Param('type') type: string,
    @Body() body: { value: string; orden?: number },
    @Req() req: any,
  ) {
    this.checkCatalogManageAccess(req, type);
    return this.catalogsService.create(type, body);
  }

  @Delete(':type/:id')
  @ApiOperation({
    summary: 'Eliminar el nodo de un catálogo usando su ID primario UUID',
  })
  deleteItem(@Param('type') type: string, @Param('id') id: string, @Req() req: any) {
    this.checkCatalogManageAccess(req, type);
    return this.catalogsService.delete(type, id);
  }

  @Put(':type/:id')
  @ApiOperation({ summary: 'Actualizar la información de un ítem de catálogo' })
  updateItem(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    this.checkCatalogManageAccess(req, type);
    return this.catalogsService.update(type, id, body);
  }
}
