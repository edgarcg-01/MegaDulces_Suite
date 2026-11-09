import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CANONICAL_PARAM, isPlatformAdminRole, Permission, RequirePermissions, RolesGuard, ScopeService, todayMx,
} from '@megadulces/platform-core';
import type { GuiaRepartoBusqueda, GuiaRepartoHoja, GuiaRepartoQuien, GuiaRepartoViajes } from '@megadulces/contracts';
import { ErpShipmentsService } from './erp-shipments.service';

/** Lo que el guard deja en la petición: quién es y qué claves tiene. */
interface Sesion {
  user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> };
}

/**
 * `[EMB.56]` Quién ve qué viaje (PM, 2026-11-09): **cada chofer, sólo los suyos**. Quien ya ve
 * embarques (`LOGISTICS_SHIPMENTS_VER`) o administra la plataforma ve todos los de su alcance, para
 * reimprimirle la guía al chofer.
 */
export function quienPide(req: Sesion | undefined): GuiaRepartoQuien {
  const u = req?.user;
  if (isPlatformAdminRole(u?.role_name) || u?.permissions?.[Permission.LOGISTICS_SHIPMENTS_VER] === true) return { todos: true };
  return { todos: false, user_id: u?.sub ?? null };
}

/**
 * `[EMB.56]` La guía de reparto — la hoja de ruta del chofer (FASE_EMB §8).
 *
 * Controlador aparte de `ErpShipmentsController` a propósito: aquel pide `LOGISTICS_SHIPMENTS_VER`
 * y devuelve importes y comisiones; éste pide la clave del chofer (`LOGISTICS_GUIA_REPARTO_VER`),
 * no devuelve un solo peso, RECORTA a la sucursal del usuario y, si es chofer, a SUS viajes.
 * Sólo lectura.
 *
 * ⚠️ `viajes` y `buscar` van ANTES que `:sucursal/:guia`, o Nest los resuelve como sucursal.
 */
@ApiTags('logistics-guia-reparto')
@UseGuards(RolesGuard)
@Controller('logistics/guia-reparto')
export class GuiaRepartoController {
  constructor(
    private readonly service: ErpShipmentsService,
    private readonly scope: ScopeService,
  ) {}

  @Get('viajes')
  @RequirePermissions(Permission.LOGISTICS_GUIA_REPARTO_VER)
  @ApiQuery({ name: 'fecha', required: false, description: 'YYYY-MM-DD. Default: hoy (hora de México).' })
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal. Se recorta a tu alcance.' })
  @ApiOperation({ summary: 'Los viajes del día de tu sucursal (si eres chofer, sólo los tuyos), para escoger e imprimir la guía. Sin importes.' })
  async viajes(@Query() raw: Record<string, string>, @Req() req: Sesion): Promise<GuiaRepartoViajes> {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(raw?.fecha ?? '') ? raw.fecha : todayMx();
    const sucursales = await this.scope.readParam(raw, 'warehouse', 'logistics/guia-reparto/viajes');
    return this.service.viajesGuiaReparto(fecha, sucursales, quienPide(req));
  }

  @Get('buscar')
  @RequirePermissions(Permission.LOGISTICS_GUIA_REPARTO_VER)
  @ApiQuery({ name: 'guia', required: true, description: 'Número de guía como se teclea: «969», «0000969» o «G-969».' })
  @ApiOperation({ summary: 'Una guía por su número, para reimprimirla. Puede dar varios viajes (el número es por sucursal). Mismo alcance y mismo filtro por chofer que la lista.' })
  async buscar(@Query() raw: Record<string, string>, @Req() req: Sesion): Promise<GuiaRepartoBusqueda> {
    const sucursales = await this.scope.readParam(raw, 'warehouse', 'logistics/guia-reparto/buscar');
    return this.service.buscarGuiaReparto(raw?.guia ?? '', sucursales, quienPide(req));
  }

  @Get(':sucursal/:guia')
  @RequirePermissions(Permission.LOGISTICS_GUIA_REPARTO_VER)
  @ApiOperation({ summary: 'La guía de reparto de un viaje: paradas en orden de visita, domicilio de entrega, bultos y folios de pedido, embarque y factura. Sin importes. Un chofer sólo abre los suyos.' })
  async guia(@Param('sucursal') sucursal: string, @Param('guia') guia: string, @Req() req: Sesion): Promise<GuiaRepartoHoja> {
    // Fuera de su alcance se responde igual que si no existiera: no se confirma qué viajes hay en
    // otra sucursal (ni, para un chofer, los de otro chofer: eso lo resuelve el servicio).
    const permitidas = await this.scope.readParam({ [CANONICAL_PARAM.warehouse]: sucursal }, 'warehouse', 'logistics/guia-reparto');
    if (permitidas && !permitidas.includes(sucursal)) {
      throw new NotFoundException(`Kepler no tiene el viaje ${sucursal}-G${guia}`);
    }
    return this.service.guiaReparto(sucursal, guia, quienPide(req));
  }
}
