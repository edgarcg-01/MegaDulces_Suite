import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ReqUser } from '@megadulces/platform-core';
import { BlindCountService } from './blind-count.service';
import type { BlindCountDto } from './blind-count.service';

/**
 * SM.8/P1 — Superficie de arqueo ciego para CAJERAS (proyecto Tienda, /tienda/arqueo).
 *
 * Reusa `BlindCountService` (misma tabla `reconciliation.blind_counts` que el
 * Supervisor de Movimientos), pero:
 *  - scopeada por permiso propio (`STORE_ARQUEO_*`), no por el motor de reconciliación;
 *  - la sucursal SIEMPRE es la del usuario si está asignada (no puede capturar/ver otra);
 *  - se OCULTA la inteligencia de enmascaramiento de Kepler (`kepler_*`): la cajera ve
 *    SU diferencia (faltante/sobrante) pero no el flag de "Kepler enmascaró" — eso queda
 *    solo para el supervisor en /almacen/cuadre.
 */
type AuthUser = { username?: string; warehouse_code?: string } | undefined;

@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/arqueo')
export class StoreArqueoController {
  constructor(private readonly blind: BlindCountService) {}

  /** Quita los campos de inteligencia de Kepler: la cajera solo ve su diferencia. */
  private strip<T extends Record<string, any>>(r: T) {
    const { kepler_enmascaro, kepler_contado, kepler_diff, ...rest } = r;
    return rest;
  }

  @Post()
  @RequirePermissions(Permission.STORE_ARQUEO_CAPTURAR)
  @ApiOperation({ summary: 'Tienda — la cajera captura su arqueo CIEGO y recibe su diferencia real (sin datos de enmascaramiento).' })
  async submit(@Body() body: BlindCountDto, @ReqUser() user: AuthUser) {
    // La cajera con sucursal asignada SIEMPRE captura sobre su sucursal (no puede suplantar otra).
    const warehouse_code = user?.warehouse_code || body?.warehouse_code;
    const res = await this.blind.submit({ ...body, warehouse_code }, user?.username);
    return this.strip(res);
  }

  @Get()
  @RequirePermissions(Permission.STORE_ARQUEO_VER)
  @ApiQuery({ name: 'warehouse_code', required: false, description: 'Ignorado si el usuario ya está scopeado a una sucursal.' })
  @ApiOperation({ summary: 'Tienda — arqueos ciegos capturados en la sucursal de la cajera (sin datos de enmascaramiento).' })
  async list(
    @ReqUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouse_code') warehouseCode?: string,
    @Query('limit') limit?: string,
  ) {
    const effective = user?.warehouse_code || warehouseCode || undefined;
    const rows = await this.blind.list({ from, to, warehouse_code: effective, limit: limit ? Number(limit) : undefined });
    return rows.map((r) => this.strip(r));
  }
}
