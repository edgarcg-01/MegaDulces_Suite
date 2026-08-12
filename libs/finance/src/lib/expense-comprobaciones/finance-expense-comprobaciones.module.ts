import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { ExpenseComprobacionesService } from './expense-comprobaciones.service';
import { ExpenseComprobacionesController } from './expense-comprobaciones.controller';

/**
 * GX.8 — Comprobación de Gastos (2ª etapa del ciclo). Captura la comprobación de un
 * gasto de Kepler (XA1001) + su archivo. Reusa `CloudinaryModule` (adjunto img/PDF).
 * Lee los gastos del espejo `analytics.expense_documents`; NO escribe a Kepler.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule],
  controllers: [ExpenseComprobacionesController],
  providers: [ExpenseComprobacionesService],
  exports: [ExpenseComprobacionesService],
})
export class FinanceExpenseComprobacionesModule {}
