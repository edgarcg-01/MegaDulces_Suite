import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetComparisonService } from './budget-comparison.service';
import { BudgetCashflowService } from './budget-cashflow.service';
import { BudgetResultService } from './budget-result.service';
import type { BudgetResult } from '@megadulces/contracts';

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
    private readonly resultSvc: BudgetResultService,
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
  summary(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string, @Query('warehouseId') warehouseId?: string, @Query('real') real?: string) {
    // El bloque «real» agrega analytics.sales_daily (ODS) — puede ser lento en prod. Por defecto se
    // difiere (carga <1s del ledger); el frontend lo pide con ?real=1 (opt-in). «diferido» ≠ «sin datos».
    return this.svc.executiveSummary(id, { from, to, warehouseId, includeReal: real === '1' || real === 'true' });
  }

  @Get('budgets/:id/variance')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Varianza por tipo de partida: vigente + buckets + ocupación (exacto, sin ODS).' })
  variance(@Param('id') id: string) {
    return this.svc.varianceByType(id);
  }

  /**
   * `[PU.R]` El estado de resultados del ejercicio: **plan contra real, renglón por renglón**.
   *
   * ⛔ Reemplaza al `resultado()` anterior, que publicaba `plan de ventas − plan de gastos` sin
   * costo de ventas. Medido contra prod sobre el FY2027 real, eso daba **$468,804,497.42 de
   * resultado y 100 % de margen**: el sustraendo valía 0 porque el plan de gastos está vacío y el
   * renglón grande —el costo de la mercancía— no existía en la fórmula.
   */
  @Get('budgets/:id/resultado')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({
    summary:
      'PU.R — Estado de resultados: venta − costo de ventas = margen bruto − gasto operativo − '
      + 'financieros = resultado, con PLAN y REAL por separado en cada celda. La compra de '
      + 'inventario (511) y la inversión (150) van al lado, nunca sumadas: son flujo, no resultado. '
      + 'Lo que no tiene plan se declara NO MEDIDO, nunca $0.00. Trae su árbitro (la balanza) y sus '
      + 'huecos con monto.',
  })
  resultado(@Param('id') id: string): Promise<BudgetResult> {
    return this.resultSvc.incomeStatement(id);
  }
}
