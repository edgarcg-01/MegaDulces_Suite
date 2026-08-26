import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ScopeService } from '@megadulces/platform-core';
import { WeeklyAnalyticsService } from './weekly-analytics.service';

/**
 * Análisis semanal para el proyecto Tienda (/tienda/analisis-semanal).
 *
 * `[ID.4]` — **Primer dominio migrado al alcance de datos** (Fase ID / ADR-050).
 *
 * Antes acá vivía el patrón fail-OPEN que se repetía en 41 módulos:
 *
 *     const effective = user?.warehouse_code || warehouseCode || undefined;
 *
 * o sea: al que tenía sucursal se le forzaba, y **al que no la tenía se le
 * respetaba el query param** — con 83 de 117 usuarios sin sucursal en prod, el
 * default real era "ve toda la red". Y no había forma de decir "ve la 01 y la 03".
 *
 * Ahora el alcance lo resuelve `ScopeService` (`user_scopes` → `role_scopes` →
 * `none`) y `intersect()` recorta lo que el usuario pidió a lo que puede ver:
 *   - alcance `all` sin `?warehouse_code` → sin filtro (igual que antes);
 *   - alcance `all` con `?warehouse_code=03` → esa;
 *   - alcance `own`/`listed` → sus sucursales, y si pide otra se le **recorta**
 *     en silencio (lista vacía → series en cero) en vez de 403: este endpoint
 *     alimenta un tablero de varios widgets y un 403 rompe la pantalla entera.
 */

@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/analytics')
export class StoreAnalyticsController {
  constructor(
    private readonly weeklySvc: WeeklyAnalyticsService,
    private readonly scope: ScopeService,
  ) {}

  /** CSV o valor único → lista. `?warehouse_code=01,03` también funciona. */
  private pedido(raw?: string): string[] | null {
    const v = (raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return v.length ? v : null;
  }

  private async sucursales(raw?: string): Promise<string[] | null> {
    const scope = await this.scope.current();
    return this.scope.intersect(scope, 'warehouse', this.pedido(raw));
  }

  @Get('weekly')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'week', required: false, description: "Cualquier día de la semana objetivo (ISO 'YYYY-MM-DD'). Default: semana actual." })
  @ApiQuery({ name: 'weeks', required: false, description: 'Nº de semanas de la tendencia (4–26, default 12).' })
  @ApiQuery({ name: 'warehouse_code', required: false, description: 'Sucursal o CSV de sucursales. Se recorta a lo que tu alcance permite.' })
  @ApiOperation({ summary: 'Tienda — análisis semanal: KPIs semana vs anterior + tendencia + desglose por sucursal y producto. Acotado por tu alcance de sucursales.' })
  async weekly(
    @Query('week') week?: string,
    @Query('weeks') weeks?: string,
    @Query('warehouse_code') warehouseCode?: string,
  ) {
    return this.weeklySvc.weekly({
      week,
      weeks: weeks ? Number(weeks) : undefined,
      warehouse_codes: await this.sucursales(warehouseCode),
    });
  }

  @Get('range')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'warehouse_code', required: false, description: 'Sucursal o CSV de sucursales. Se recorta a lo que tu alcance permite.' })
  @ApiOperation({ summary: 'Tienda — análisis por rango personalizado: venta, tickets, ticket promedio, productos por ticket, margen, unidades + serie diaria y top productos (vs período previo). Acotado por tu alcance de sucursales.' })
  async range(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouse_code') warehouseCode?: string,
  ) {
    return this.weeklySvc.range({ from, to, warehouse_codes: await this.sucursales(warehouseCode) });
  }
}
