import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ReqUser } from '@megadulces/platform-core';
import { WeeklyAnalyticsService } from './weekly-analytics.service';

/**
 * Análisis semanal para el proyecto Tienda (/tienda/analisis-semanal).
 *
 * Scopeado por sucursal: si el usuario tiene `warehouse_code` asignado (encargado/
 * cajera), SIEMPRE se acota a su sucursal (no puede ampliar); rol global ve todas o
 * puede filtrar con ?warehouse_code. Mismo patrón que /store/live y /store/arqueo.
 */
type AuthUser = { warehouse_code?: string } | undefined;

@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/analytics')
export class StoreAnalyticsController {
  constructor(private readonly weeklySvc: WeeklyAnalyticsService) {}

  @Get('weekly')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'week', required: false, description: "Cualquier día de la semana objetivo (ISO 'YYYY-MM-DD'). Default: semana actual." })
  @ApiQuery({ name: 'weeks', required: false, description: 'Nº de semanas de la tendencia (4–26, default 12).' })
  @ApiQuery({ name: 'warehouse_code', required: false, description: 'Ignorado si el usuario ya está scopeado a una sucursal.' })
  @ApiOperation({ summary: 'Tienda — análisis semanal: KPIs semana vs anterior + tendencia + desglose por sucursal y producto.' })
  weekly(
    @ReqUser() user: AuthUser,
    @Query('week') week?: string,
    @Query('weeks') weeks?: string,
    @Query('warehouse_code') warehouseCode?: string,
  ) {
    const effective = user?.warehouse_code || warehouseCode || undefined;
    return this.weeklySvc.weekly({ week, weeks: weeks ? Number(weeks) : undefined, warehouse_code: effective });
  }
}
