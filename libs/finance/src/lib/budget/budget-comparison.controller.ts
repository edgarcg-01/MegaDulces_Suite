import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetComparisonService } from './budget-comparison.service';

/**
 * Fase PU.2 — Presupuestos: presupuesto vs real (ADR-066). Resumen ejecutivo (§5.1) + varianza por
 * tipo. Solo lectura (`PRESUPUESTOS_VER`). El real sale por VISTA/lectura del ODS (`analytics.sales_daily`),
 * nunca por copia.
 */
@ApiTags('finance-budget')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget')
export class BudgetComparisonController {
  constructor(private readonly svc: BudgetComparisonService) {}

  @Get('budgets/:id/summary')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Resumen ejecutivo: presupuesto vs real, disponible, ocupación, KPIs §10.' })
  summary(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string, @Query('warehouseId') warehouseId?: string) {
    return this.svc.executiveSummary(id, { from, to, warehouseId });
  }

  @Get('budgets/:id/variance')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Varianza por tipo de partida: vigente + buckets + ocupación (exacto, sin ODS).' })
  variance(@Param('id') id: string) {
    return this.svc.varianceByType(id);
  }
}
