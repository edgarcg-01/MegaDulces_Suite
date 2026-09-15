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

/**
 * Fase TP (ADR-064) — Calendario de Pagos: Presupuestos (capacidad + gastos autorizados) +
 * Finanzas (compromisos financieros) + el motor de asignación (lotes/allocations/agreements) +
 * documentos imprimibles (TP.8, `PaymentCalendarDocumentService` con su propio Chromium — mismo
 * patrón que Fase AX, sin cruzar la frontera finance→commercial).
 * Las obligaciones a proveedor de mercancía y el catálogo de cuentas de pago viven en
 * `@megadulces/commercial` — este módulo solo las LEE por knex directo.
 */
@Module({
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
  ],
  exports: [BudgetCapacityService, BudgetExpenseObligationsService, FinancialCommitmentsService, PaymentCalendarService],
})
export class FinancePaymentCalendarModule {}
