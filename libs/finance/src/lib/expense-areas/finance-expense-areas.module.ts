import { Module } from '@nestjs/common';
import { ExpenseAreasAssignService } from './expense-areas-assign.service';
import { ExpenseAreasAssignController } from './expense-areas-assign.controller';

/**
 * `[GX.16]` Asignación asistida de áreas de gasto. Sin dependencias de otros módulos: lee
 * `users`, `role_permissions` y `finance.expense_areas`, y escribe un campo de `users`.
 */
@Module({
  controllers: [ExpenseAreasAssignController],
  providers: [ExpenseAreasAssignService],
  exports: [ExpenseAreasAssignService],
})
export class FinanceExpenseAreasModule {}
