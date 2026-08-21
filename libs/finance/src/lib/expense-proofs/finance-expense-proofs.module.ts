import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { ExpenseProofsService } from './expense-proofs.service';
import { ExpenseProofsController } from './expense-proofs.controller';
import { ExpenseProofsGateway } from './expense-proofs.gateway';

/**
 * GX.7 — Comprobación de gasto (captura del comprobante fiscal en plataforma,
 * reemplaza el Google Form). Sube a Cloudinary + guarda en `finance.expense_proofs`.
 */
@Module({
  imports: [
    CloudinaryModule,
    AiProductMatcherModule,
    // JwtModule local para el handshake del gateway (mismo default que las otras gateways de Finanzas).
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  controllers: [ExpenseProofsController],
  providers: [ExpenseProofsService, ExpenseProofsGateway],
  exports: [ExpenseProofsService],
})
export class FinanceExpenseProofsModule {}
