import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ReqUser, ScopeService, CANONICAL_PARAM } from '@megadulces/platform-core';
import {
  REVISION_DIAS_DEFAULT,
  type ArqueoRevisionAccionDto, type ArqueoRevisionDiaDto, type ArqueoRevisionEvento, type ArqueoRevisionFirmaDia,
  type ArqueoRevisionJustificacion, type ArqueoRevisionJustificarDto, type ArqueoRevisionResp, type ArqueoRevisionResumen,
} from '@megadulces/contracts/http/arqueo-cajas';
import { TurnoRevisionService } from './turno-revision.service';
import { sumarDias } from './turno-revision';

type Usuario = { username?: string } | undefined;

/**
 * [SM.55] Revisión de turnos — la encargada de la sucursal.
 *
 * Pide `RECONCILIATION_VER`, la misma clave que «Validar arqueo» (SM.12) y «Sucursales y sus
 * cajas» (SM.48): es la que separa a la encargada (`encargado_tienda` la tiene, verificado en
 * prod el 2026-11-23) de la cajera (`cajero` no). Muestra montos de Kepler, así que la cajera
 * no la puede ver: el arqueo es ciego. Escribir pide además el alcance de ESCRITURA de esa
 * sucursal, como validar: es firmar sobre el dinero de UNA tienda.
 *
 * Prefijo propio (`store/arqueo-revision`) para no compartir rutas con `store/arqueo`, que
 * tiene `:id/validar`.
 */
@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/arqueo-revision')
export class StoreArqueoRevisionController {
  constructor(
    private readonly revision: TurnoRevisionService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiQuery({ name: 'desde', required: false, description: `'YYYY-MM-DD'. Por defecto, ${REVISION_DIAS_DEFAULT} días antes de hasta.` })
  @ApiQuery({ name: 'hasta', required: false, description: "'YYYY-MM-DD'. Por defecto, ayer (America/Mexico_City)." })
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV. Se recorta a tu alcance.' })
  @ApiOperation({ summary: 'Tienda — turnos cerrados con su estado de revisión, el control por día y los errores por cajera.' })
  async pendientes(@Query() query: Record<string, unknown>): Promise<ArqueoRevisionResp> {
    const { desde, hasta } = this.rango(query);
    return this.revision.pendientes(desde, hasta, await this.scope.readParam(query, 'warehouse', 'store/arqueo-revision'));
  }

  @Get('resumen')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Tienda — cuántos turnos esperan a la encargada (para el aviso de las pestañas).' })
  async resumen(@Query() query: Record<string, unknown>): Promise<ArqueoRevisionResumen> {
    const { desde, hasta } = this.rango(query);
    return this.revision.resumen(desde, hasta, await this.scope.readParam(query, 'warehouse', 'store/arqueo-revision'));
  }

  @Post()
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Tienda — la encargada justifica un turno: causa + nota; queda quién y cuándo.' })
  async justificar(@Body() body: ArqueoRevisionJustificarDto, @ReqUser() user: Usuario): Promise<ArqueoRevisionJustificacion> {
    const code = await this.sucursalEscribible(body?.warehouse_code);
    return this.revision.justificar({ ...body, warehouse_code: code }, user?.username);
  }

  @Post('accion')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Tienda — qué se hizo con un turno ya justificado; con cerrar=true el caso queda cerrado.' })
  async accion(@Body() body: ArqueoRevisionAccionDto, @ReqUser() user: Usuario): Promise<ArqueoRevisionEvento[]> {
    const code = await this.sucursalEscribible(body?.warehouse_code);
    return this.revision.accion({ ...body, warehouse_code: code }, user?.username);
  }

  @Post('dia')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Tienda — la encargada firma que revisó un día de su sucursal (sin turnos por justificar).' })
  async dia(@Body() body: ArqueoRevisionDiaDto, @ReqUser() user: Usuario): Promise<ArqueoRevisionFirmaDia> {
    const code = await this.sucursalEscribible(body?.warehouse_code);
    return this.revision.marcarDia({ ...body, warehouse_code: code }, user?.username);
  }

  private rango(query: Record<string, unknown>): { desde: string; hasta: string } {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const hasta = String(query?.['hasta'] ?? '').trim() || sumarDias(hoy, -1);
    const desde = String(query?.['desde'] ?? '').trim() || sumarDias(hasta, -(REVISION_DIAS_DEFAULT - 1));
    if (hasta > hoy) throw new BadRequestException('hasta no puede ser una fecha futura.');
    return { desde, hasta };
  }

  private async sucursalEscribible(v: unknown): Promise<string> {
    const code = String(v ?? '').trim();
    if (!code) throw new BadRequestException('Falta la sucursal.');
    await this.scope.assertCanWrite('warehouse', code);
    return code;
  }
}
