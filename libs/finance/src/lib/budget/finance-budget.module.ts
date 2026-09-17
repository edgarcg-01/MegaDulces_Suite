import { Module } from '@nestjs/common';
import { BudgetLinesService } from './budget-lines.service';
import { BudgetLinesController } from './budget-lines.controller';
import { BudgetComparisonService } from './budget-comparison.service';
import { BudgetComparisonController } from './budget-comparison.controller';

/**
 * Fase PU — Presupuestos (ADR-066). Sistema de presupuestos: motor de egresos (PU.1, ledger de 5
 * estados) + presupuesto vs real (PU.2, comparación contra `analytics.sales_daily` del ODS).
 * Separado del `FinancePaymentCalendarModule` (Fase TP) a propósito: aquel es el ALIMENTADOR del
 * calendario; éste es el sistema de presupuestos. Comparten el schema `budget.*` pero no el módulo.
 */
@Module({
  controllers: [BudgetLinesController, BudgetComparisonController],
  providers: [BudgetLinesService, BudgetComparisonService],
  exports: [BudgetLinesService, BudgetComparisonService],
})
export class FinanceBudgetModule {}
