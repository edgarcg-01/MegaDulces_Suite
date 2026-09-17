import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetComparisonService } from './budget-comparison.service';
import { BudgetCashflowService } from './budget-cashflow.service';

/**
 * Fase PU.2/PU.3 — Presupuestos: presupuesto vs real (§5.1) + flujo de efectivo previsto (§10).
 * Solo lectura (`PRESUPUESTOS_VER`). El real sale por VISTA/lectura del ODS (`analytics.sales_daily`,
 * `analytics.customer_receivables`) y de las obligaciones/bancos ya existentes, nunca por copia.
 */
@ApiTags('finance-budget')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget')
export class BudgetComparisonController {
  constructor(
    private readonly svc: BudgetComparisonService,
    private readonly cashflow: BudgetCashflowService,
  ) {}

  @Get('cashflow')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Flujo de efectivo previsto por semana: cobros (cartera) − pagos (obligaciones) sobre saldo bancario. Saldo mínimo proyectado + alerta de insuficiencia.' })
  cashflowProjection(@Query('from') from?: string, @Query('to') to?: string) {
    return this.cashflow.projection({ from, to });
  }

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
