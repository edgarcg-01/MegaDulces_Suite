import { Module } from '@nestjs/common';
import { BudgetLinesService } from './budget-lines.service';
import { BudgetLinesController } from './budget-lines.controller';
import { BudgetComparisonService } from './budget-comparison.service';
import { BudgetComparisonController } from './budget-comparison.controller';
import { BudgetCashflowService } from './budget-cashflow.service';
import { BudgetPlanningService } from './budget-planning.service';
import { BudgetPlanningController } from './budget-planning.controller';
import { BudgetCampaignsService } from './budget-campaigns.service';
import { BudgetCampaignsController } from './budget-campaigns.controller';

/**
 * Fase PU — Presupuestos (ADR-066). Sistema de presupuestos: motor de egresos (PU.1, ledger de 5
 * estados) + presupuesto vs real (PU.2, comparación contra `analytics.sales_daily` del ODS) + flujo
 * de efectivo previsto (PU.3, cartera CXC − obligaciones sobre saldo bancario CB) + planeación
 * avanzada (PU.4, escenarios/copia/comparación/import idempotente/proyección de cierre) + Marketing
 * (PU.5, catálogo de campañas + aportaciones + evaluación honesta).
 * Separado del `FinancePaymentCalendarModule` (Fase TP) a propósito: aquel es el ALIMENTADOR del
 * calendario; éste es el sistema de presupuestos. Comparten el schema `budget.*` pero no el módulo.
 */
@Module({
  controllers: [BudgetLinesController, BudgetComparisonController, BudgetPlanningController, BudgetCampaignsController],
  providers: [BudgetLinesService, BudgetComparisonService, BudgetCashflowService, BudgetPlanningService, BudgetCampaignsService],
  exports: [BudgetLinesService, BudgetComparisonService, BudgetCashflowService, BudgetPlanningService, BudgetCampaignsService],
})
export class FinanceBudgetModule {}
