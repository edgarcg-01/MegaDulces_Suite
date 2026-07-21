import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { ExpenseProofsService } from './expense-proofs.service';
import { ExpenseProofsController } from './expense-proofs.controller';

/**
 * GX.7 — Comprobación de gasto (captura del comprobante fiscal en plataforma,
 * reemplaza el Google Form). Sube a Cloudinary + guarda en `finance.expense_proofs`.
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [ExpenseProofsController],
  providers: [ExpenseProofsService],
  exports: [ExpenseProofsService],
})
export class FinanceExpenseProofsModule {}
