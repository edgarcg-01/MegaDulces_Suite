import { Module } from '@nestjs/common';
import { BudgetLinesService } from './budget-lines.service';
import { BudgetLinesController } from './budget-lines.controller';

/**
 * Fase PU.1 — Presupuestos: motor de egresos (ADR-066). Cabecera + partidas + ledger de 5 estados.
 * Separado del `FinancePaymentCalendarModule` (Fase TP) a propósito: aquel es el ALIMENTADOR del
 * calendario; éste es el sistema de presupuestos. Comparten el schema `budget.*` pero no el módulo.
 */
@Module({
  controllers: [BudgetLinesController],
  providers: [BudgetLinesService],
  exports: [BudgetLinesService],
})
export class FinanceBudgetModule {}
