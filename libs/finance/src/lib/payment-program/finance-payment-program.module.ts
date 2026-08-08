import { Module } from '@nestjs/common';
import { PaymentProgramService } from './payment-program.service';
import { PaymentProgramController } from './payment-program.controller';

/**
 * Fase PP.2 — Programa de Pagos (Tesorería). Read-only sobre finance.payment_program
 * (espejo del Excel de Tesorería, cargado por import-payment-program.js). Sin dependencias
 * externas: TenantKnexService/TenantContextService vienen del core global.
 */
@Module({
  controllers: [PaymentProgramController],
  providers: [PaymentProgramService],
  exports: [PaymentProgramService],
})
export class FinancePaymentProgramModule {}
