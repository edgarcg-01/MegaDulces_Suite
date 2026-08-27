import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ScopeService, CANONICAL_PARAM } from '@megadulces/platform-core';
import { WeeklyAnalyticsService } from './weekly-analytics.service';

/**
 * Análisis semanal para el proyecto Tienda (/tienda/analisis-semanal).
 *
 * `[ID.4]` — Primer dominio migrado al alcance de datos (Fase ID / ADR-050).
 * `[ID.5]` — Y primero en usar el contrato canónico de params.
 *
 * Antes acá vivía el patrón fail-OPEN que se repetía en 41 módulos:
 *
 *     const effective = user?.warehouse_code || warehouseCode || undefined;
 *
 * o sea: al que tenía sucursal se le forzaba, y **al que no la tenía se le
 * respetaba el query param** — con 83 de 117 usuarios sin sucursal en prod, el
 * default real era "ve toda la red". Y no había forma de decir "ve la 01 y la 03".
 *
 * Ahora `ScopeService.readParam()` hace las tres cosas de una: lee el nombre
 * (canónico o cualquiera de los alias viejos), normaliza la llave (acepta
 * código y uuid) y recorta lo pedido al alcance del usuario:
 *   - alcance `all` sin filtro pedido → sin filtro (igual que antes);
 *   - alcance `all` con `?warehouse_codes=03` → esa;
 *   - alcance `own`/`listed` → sus sucursales, y si pide otra se le **recorta**
 *     en silencio (lista vacía → series en cero) en vez de 403: este endpoint
 *     alimenta un tablero de varios widgets y un 403 rompe la pantalla entera.
 */

const WH = CANONICAL_PARAM.warehouse; // 'warehouse_codes'
const DESC_WH = `Sucursal o CSV de sucursales. Se recorta a lo que tu alcance permite. Acepta los nombres viejos (warehouse_code, sucursal, branch…) y valores en código o uuid.`;

@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/analytics')
export class StoreAnalyticsController {
  constructor(
    private readonly weeklySvc: WeeklyAnalyticsService,
    private readonly scope: ScopeService,
  ) {}

  @Get('weekly')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'week', required: false, description: "Cualquier día de la semana objetivo (ISO 'YYYY-MM-DD'). Default: semana actual." })
  @ApiQuery({ name: 'weeks', required: false, description: 'Nº de semanas de la tendencia (4–26, default 12).' })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiOperation({ summary: 'Tienda — análisis semanal: KPIs semana vs anterior + tendencia + desglose por sucursal y producto. Acotado por tu alcance de sucursales.' })
  async weekly(@Query() query: Record<string, unknown>) {
    const weeks = query['weeks'];
    return this.weeklySvc.weekly({
      week: query['week'] as string | undefined,
      weeks: weeks ? Number(weeks) : undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/weekly'),
    });
  }

  @Get('range')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiOperation({ summary: 'Tienda — análisis por rango personalizado: venta, tickets, ticket promedio, productos por ticket, margen, unidades + serie diaria y top productos (vs período previo). Acotado por tu alcance de sucursales.' })
  async range(@Query() query: Record<string, unknown>) {
    return this.weeklySvc.range({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/range'),
    });
  }
}
