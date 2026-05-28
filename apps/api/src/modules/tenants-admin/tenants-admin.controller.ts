import { Body, Controller, Get, Param, Post, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TenantsAdminService, CreateTenantDto } from './tenants-admin.service';

/**
 * Endpoints de admin de tenants. **PROTECCIÓN PENDIENTE** (Sprint A.0mt.5):
 * por ahora sin guards porque la app no está wireada aún. En el cutover
 * se agregará un guard "platform_admin" que verifica un secret separado del
 * sistema de roles por-tenant (porque estas operaciones son cross-tenant).
 */
@ApiTags('tenants-admin')
@Controller('admin/tenants')
export class TenantsAdminController {
  constructor(private readonly service: TenantsAdminService) {}

  @Post()
  @ApiOperation({ summary: 'Crear nuevo tenant' })
  create(@Body() body: CreateTenantDto) {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar todos los tenants' })
  findAll() {
    return this.service.findAll();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Obtener tenant por slug' })
  findOne(@Param('slug') slug: string) {
    return this.service.findBySlug(slug);
  }

  @Delete(':slug')
  @ApiOperation({ summary: 'Desactivar tenant (soft-delete via activo=false)' })
  deactivate(@Param('slug') slug: string) {
    return this.service.deactivate(slug);
  }
}
