import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  isPlatformAdminRole,
  Permission,
  RequireAnyPermission,
} from '@megadulces/platform-core';
import {
  ActorTarifas,
  LogisticsConfigService,
  CreateConfigDto,
  UpdateConfigDto,
  ConfigCategory,
} from './logistics-config.service';

interface SesionTarifas {
  user?: { sub?: string; username?: string; role_name?: string; permissions?: Record<string, boolean> };
}

/**
 * `[EMB.28.1]` Quién cambia una tarifa, leído de la SESIÓN (nunca del cuerpo). Es autorizador quien
 * tiene `LOGISTICS_TARIFAS_AUTORIZAR` o es administrador de plataforma.
 */
export function actorDe(req: SesionTarifas | undefined): ActorTarifas {
  const u = req?.user;
  return {
    userId: u?.sub ?? null,
    username: u?.username ?? null,
    autorizador: isPlatformAdminRole(u?.role_name) || u?.permissions?.[Permission.LOGISTICS_TARIFAS_AUTORIZAR] === true,
  };
}

/**
 * `[AUTHZ.5]` — Controller sin autorización hasta acá (ver `logistics-fleet.controller`). Acá viven
 * las **tarifas y comisiones** con las que se paga: quien las edite mueve dinero.
 *
 * `[EMB.28.1]` Escribir lo puede quien configura (`LOGISTICS_CONFIG_GESTIONAR`) o el autorizador de tarifas
 * (`LOGISTICS_TARIFAS_AUTORIZAR`, que no siempre trae el otro: dirección). Qué tarifa puede tocar cada
 * uno lo decide el SERVICIO (una ya fijada sólo el autorizador). No hay permiso de lectura. Las **lecturas** se
 * abren también a `LOGISTICS_SHIPMENTS_VER` porque el formulario de embarque consume el catálogo de
 * rutas/destinos: exigir el de gestión para leerlo rompía la pantalla de quien sólo programa viajes.
 */
@ApiTags('logistics-config')
@Controller('logistics/config')
export class LogisticsConfigController {
  constructor(private readonly service: LogisticsConfigService) {}

  @Post()
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'Crear config_finance' })
  create(@Body() body: CreateConfigDto, @Req() req: SesionTarifas) {
    return this.service.create(body, actorDe(req));
  }

  @Get()
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Listar config_finance del tenant' })
  list(@Query('category') category?: ConfigCategory, @Query('active') active?: string) {
    return this.service.list({
      category,
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Get(':id')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Obtener config por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'Actualizar config (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdateConfigDto, @Req() req: SesionTarifas) {
    return this.service.update(id, body, actorDe(req));
  }

  @Delete(':id')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'Hard-delete config (no soft-delete: poco data y se reemplaza)' })
  remove(@Param('id') id: string, @Req() req: SesionTarifas) {
    return this.service.delete(id, actorDe(req));
  }

  @Get(':id/historial')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'EMB.28.1: historia de un renglón de configuración (quién, cuándo, antes y después)' })
  historialConfig(@Param('id') id: string) {
    return this.service.historial('config', id);
  }

  // ── J.9.8 — Routes CRUD (Comisiones por ruta del catálogo destinos) ────
  @Get('routes/list')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'J.9.8: listar routes (96 destinos reales del importer baseline)' })
  listRoutes(@Query('active') active?: string, @Query('search') search?: string) {
    return this.service.listRoutes({
      active: active === undefined ? undefined : active === 'true',
      search: search || undefined,
    });
  }

  @Post('routes')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'J.9.8: crear route con comisiones' })
  createRoute(@Body() body: any, @Req() req: SesionTarifas) {
    return this.service.createRoute(body, actorDe(req));
  }

  @Patch('routes/:id')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'J.9.8: actualizar route (parcial)' })
  updateRoute(@Param('id') id: string, @Body() body: any, @Req() req: SesionTarifas) {
    return this.service.updateRoute(id, body, actorDe(req));
  }

  @Delete('routes/:id')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'J.9.8: soft-delete route' })
  deleteRoute(@Param('id') id: string, @Req() req: SesionTarifas) {
    return this.service.deleteRoute(id, actorDe(req));
  }

  @Get('routes/:id/historial')
  @RequireAnyPermission(Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR)
  @ApiOperation({ summary: 'EMB.28.1: historia de la tarifa de una ruta (quién, cuándo, antes y después)' })
  historialRuta(@Param('id') id: string) {
    return this.service.historial('route', id);
  }
}
