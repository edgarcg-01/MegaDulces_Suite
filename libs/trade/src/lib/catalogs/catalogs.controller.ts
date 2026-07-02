import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CatalogsService } from './catalogs.service';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';
import { RequireAuthGuard } from '@megadulces/platform-core';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createMongoAbility } from '@casl/ability';
import type { AppAbility } from '@megadulces/platform-core';

@ApiTags('catalogs')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('catalogs')
export class CatalogsController {
  constructor(private readonly catalogsService: CatalogsService) {}

  private checkCatalogManageAccess(req: any, type: string) {
    const ability = createMongoAbility<AppAbility>(req.user.rules || []);
    if (ability.can('manage', 'all')) return;

    if (['conceptos', 'ubicaciones', 'niveles'].includes(type)) {
      if (!ability.can('manage', 'scoring_config')) {
        throw new ForbiddenException(
          'No tienes permisos suficientes para gestionar parámetros del scoring.',
        );
      }
    } else if (type === 'roles') {
      if (!ability.can('manage', 'roles_config')) {
        throw new ForbiddenException(
          'No tienes permisos para gestionar roles del sistema.',
        );
      }
    } else {
      if (!ability.can('manage', 'catalogs')) {
        throw new ForbiddenException(
          'No tienes permisos para gestionar catálogos maestros.',
        );
      }
    }
  }

  @Get('permissions/:role_name')
  @RequirePermissions(Permission.ROLES_VER)
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
    // Tipo PLANO (Record) en lugar de un DTO de clase — el `@UsePipes(
    // ValidationPipe { whitelist: true })` a nivel de controller, combinado
    // con un DTO que solo tenía index signature `[k: string]: boolean`,
    // borraba TODAS las keys del body (whitelist sólo conserva propiedades
    // declaradas con decoradores de class-validator). Con tipo plano, la
    // metadata de reflect resulta `Object` y el pipe pasa el body intacto.
    // La validación real (whitelist por enum Permission) la hace el service.
    @Body() body: Record<string, boolean>,
    @Req() req: any,
  ) {
    return this.catalogsService.updateRolePermissions(
      roleName,
      body,
      req.user,
    );
  }

  @Get(':type')
  // Sin @RequirePermissions: el catálogo es metadata compartida que consumen
  // múltiples módulos (captures/mobile lee conceptos/ubicaciones/niveles,
  // daily-assignments lee rutas, seguimiento lee zonas, etc.). El control
  // de mutaciones sí está protegido por checkCatalogManageAccess().
  @ApiOperation({
    summary: 'Obtener un catálogo estructurado (ej. zonas, periodos, semanas, roles)',
  })
  @ApiParam({ name: 'type', description: 'El catálogo que deseas consumir' })
  @ApiQuery({
    name: 'parent',
    required: false,
    description: 'Filtrar por ID del padre (ej. zona para obtener rutas)',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    description: 'Incluir ítems soft-deleted (default: false)',
    type: Boolean,
  })
  getByType(
    @Param('type') type: string,
    @Query('parent') parentId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.catalogsService.getByType(
      type,
      parentId,
      includeInactive === 'true',
    );
  }

  @Post(':type')
  @ApiOperation({
    summary: 'Añadir un ítem dinámico nuevo al tipo de catálogo definido',
  })
  create(
    @Param('type') type: string,
    @Body() dto: CreateCatalogItemDto,
    @Req() req: any,
  ) {
    this.checkCatalogManageAccess(req, type);
    return this.catalogsService.create(type, dto, req.user.sub);
  }

  @Delete(':type/:id')
  @ApiOperation({
    summary:
      'Eliminar un ítem. Soft-delete automático si está referenciado por capturas o por la versión activa de scoring; hard-delete si no.',
  })
  deleteItem(
    @Param('type') type: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    this.checkCatalogManageAccess(req, type);
    return this.catalogsService.delete(type, id, req.user.sub);
  }

  @Put(':type/:id')
  @ApiOperation({ summary: 'Actualizar la información de un ítem de catálogo' })
  updateItem(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: UpdateCatalogItemDto,
    @Req() req: any,
  ) {
    this.checkCatalogManageAccess(req, type);
    return this.catalogsService.update(type, id, dto, req.user.sub);
  }
}
