import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetComparisonService } from './budget-comparison.service';
import { BudgetCashflowService } from './budget-cashflow.service';
import { BudgetResultService } from './budget-result.service';
import { CashCycleService } from './cash-cycle.service';
import { PendingApprovalsService } from './pending-approvals.service';
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
    private readonly cycle: CashCycleService,
    private readonly firmas: PendingApprovalsService,
  ) {}

  /**
   * `[TES.17]` La bandeja de firmas. `PRESUPUESTOS_VER` y no `_APROBAR` a propósito: **ver qué
   * espera una firma no es firmar**, y quien prepara necesita saber si lo que mandó llegó.
   * El freno de la acción sigue donde siempre estuvo — en `approve` y en `authorize`.
   *
   * ⚠️ Devuelve `vacia_porque` cuando no hay nada: una bandeja vacía y una tubería trabada se
   * ven igual, y hoy en prod son cero items con 312 obligaciones esperando aguas arriba.
   */
  @Get('firmas-pendientes')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Qué espera una firma: ejercicios en pendiente + obligaciones en propuesta, con monto, antigüedad (proxy declarado) y qué se traba si no se firma. Si está vacía, declara POR QUÉ.' })
  firmasPendientes() {
    return this.firmas.bandeja();
  }

  @Get('cashflow')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Flujo de efectivo previsto por semana: cobros (cartera) − pagos (obligaciones) sobre saldo bancario. Saldo mínimo proyectado + alerta de insuficiencia.' })
  cashflowProjection(@Query('from') from?: string, @Query('to') to?: string) {
    return this.cashflow.projection({ from, to });
  }

  /**
   * `[TES.13]` Ruta propia y no un campo del flujo, a propósito: el flujo ya cuesta ~2.4 s por
   * la ventana FIFO de la cartera, y colgarle tres agregados de 90 días lo empeora para quien
   * sólo quiere la curva. Quien pregunta por el ciclo, pregunta por el ciclo.
   */
  @Get('cash-cycle')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Ciclo de conversión de efectivo: DSO y DPO medidos sobre 90 días. El DPO va con y sin la masa de deuda en disputa; el DIO se declara pendiente con su motivo.' })
  cashCycle() {
    return this.cycle.cycle();
  }

  /**
   * `[TES.14]` El estrés que el encargo pedía al revés. No «y si la venta cae 20 %» —una caída
   * de hoy no cambia lo que vence el martes— sino **cuánto de lo vencido hay que cobrar por
   * semana, y si eso cabe en lo que el negocio ya cobra**.
   */
  @Get('cash-runway')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Holgura de liquidez: el hueco de la ventana, la recuperación semanal que exige, y qué porcentaje es eso del cobro histórico real. Con veredicto.' })
  cashRunway() {
    return this.cycle.runway();
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
