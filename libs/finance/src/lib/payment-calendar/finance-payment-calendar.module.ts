import { Module } from '@nestjs/common';
import { BudgetCapacityService } from './budget-capacity.service';
import { BudgetCapacityController } from './budget-capacity.controller';
import { BudgetExpenseObligationsService } from './budget-expense-obligations.service';
import { BudgetExpenseObligationsController } from './budget-expense-obligations.controller';
import { FinancialCommitmentsService } from './financial-commitments.service';
import { FinancialCommitmentsController } from './financial-commitments.controller';
import { PaymentCalendarService } from './payment-calendar.service';
import { PaymentCalendarDocumentService } from './payment-calendar-document.service';
import { PaymentCalendarController } from './payment-calendar.controller';
import { FinanceBudgetModule } from '../budget/finance-budget.module';
import { BudgetLinesService } from '../budget/budget-lines.service';
import { BUDGET_LEDGER_PORT } from '../budget/budget-ledger.port';

/**
 * Fase TP (ADR-064) — Calendario de Pagos: Presupuestos (capacidad + gastos autorizados) +
 * Finanzas (compromisos financieros) + el motor de asignación (lotes/allocations/agreements) +
 * documentos imprimibles (TP.8, `PaymentCalendarDocumentService` con su propio Chromium — mismo
 * patrón que Fase AX, sin cruzar la frontera finance→commercial).
 * Las obligaciones a proveedor de mercancía y el catálogo de cuentas de pago viven en
 * `@megadulces/commercial` — este módulo solo las LEE por knex directo.
 */
@Module({
  // Importa FinanceBudgetModule sólo para el puerto del ledger (unificar el gasto — ADR-066). Sin ciclo:
  // FinanceBudgetModule no importa nada de payment-calendar.
  imports: [FinanceBudgetModule],
  controllers: [
    BudgetCapacityController,
    BudgetExpenseObligationsController,
    FinancialCommitmentsController,
    PaymentCalendarController,
  ],
  providers: [
    BudgetCapacityService,
    BudgetExpenseObligationsService,
    FinancialCommitmentsService,
    PaymentCalendarService,
    PaymentCalendarDocumentService,
    // El movimiento del ledger de la partida lo hace BudgetLinesService, expuesto por token para no
    // acoplar TP a la clase concreta (BUDGET_LEDGER_PORT).
    { provide: BUDGET_LEDGER_PORT, useExisting: BudgetLinesService },
  ],
  exports: [BudgetCapacityService, BudgetExpenseObligationsService, FinancialCommitmentsService, PaymentCalendarService],
})
export class FinancePaymentCalendarModule {}
