import { Body, Controller, Get, Param, Post, Delete, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { TenantsAdminService, CreateTenantDto } from './tenants-admin.service';
import { PlatformAdminGuard, PLATFORM_ADMIN_HEADER } from './platform-admin.guard';

/**
 * `[AUTHZ.5]` — Endpoints de admin de tenants. **Operaciones CROSS-TENANT.**
 *
 * El TODO que decía *"protección pendiente (Sprint A.0mt.5), por ahora sin guards porque la app no
 * está wireada aún"* sobrevivió al cutover: el módulo quedó montado en `AppModule` y las 4 rutas
 * siguieron abiertas. Como `RolesGuard` es no-op sin `@RequirePermissions`, **cualquier usuario
 * autenticado** podía crear un tenant, listar todos y desactivar el de Mega Dulces.
 *
 * `PlatformAdminGuard` implementa lo que ese mismo TODO proponía: un secreto de despliegue separado
 * del sistema de roles —que es **por tenant** y por lo tanto no puede autorizar algo cross-tenant—
 * más una sesión de administrador para que quede quién lo hizo. Fail-closed sin el secreto.
 */
@ApiTags('tenants-admin')
@ApiHeader({ name: PLATFORM_ADMIN_HEADER, description: 'Secreto de operador de plataforma (env PLATFORM_ADMIN_KEY)', required: true })
@UseGuards(PlatformAdminGuard)
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
