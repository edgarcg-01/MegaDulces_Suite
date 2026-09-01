import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions, Permission } from '@megadulces/platform-core';
import { DbHealthService } from './db-health.service';
import { DbHealthScannerService } from './db-health-scanner.service';

/**
 * Salud/frescura de la DB de la app. Solo lectura. Gateado por USUARIOS_GESTIONAR
 * (permiso de Administración). Los guards globales (JwtAuthGuard + RolesGuard) están
 * activos bajo ENABLE_MULTITENANT, así que @RequirePermissions es lo que aplica.
 */
@ApiTags('db-health')
@Controller('admin/db-health')
export class DbHealthController {
  constructor(
    private readonly service: DbHealthService,
    private readonly scanner: DbHealthScannerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Reporte de frescura de las fuentes de datos críticas' })
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  getReport() {
    return this.service.getReport();
  }

  @Get('engine')
  @ApiOperation({ summary: 'Salud del MOTOR Postgres: hinchazón, peso, actividad, autovacuum' })
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  getEngine() {
    return this.service.getEngineReport();
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Bandeja de alertas de salud (abiertas + resueltas recientes)' })
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  listAlerts() {
    return this.service.listAlerts();
  }

  @Post('alerts/:id/ack')
  @ApiOperation({ summary: 'Marcar una alerta de salud como reconocida' })
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  ack(@Param('id') id: string) {
    return this.service.ackAlert(id);
  }

  @Post('scan-now')
  @ApiOperation({ summary: 'Correr el scanner de salud ahora (manual)' })
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  scanNow() {
    return this.scanner.scanNow();
  }
}
