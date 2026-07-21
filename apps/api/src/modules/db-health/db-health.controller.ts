import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions, Permission } from '@megadulces/platform-core';
import { DbHealthService } from './db-health.service';

/**
 * Salud/frescura de la DB de la app. Solo lectura. Gateado por USUARIOS_GESTIONAR
 * (permiso de Administración). Los guards globales (JwtAuthGuard + RolesGuard) están
 * activos bajo ENABLE_MULTITENANT, así que @RequirePermissions es lo que aplica.
 */
@ApiTags('db-health')
@Controller('admin/db-health')
export class DbHealthController {
  constructor(private readonly service: DbHealthService) {}

  @Get()
  @ApiOperation({ summary: 'Reporte de frescura de las fuentes de datos críticas' })
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  getReport() {
    return this.service.getReport();
  }
}
