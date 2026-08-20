import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { ExpenseComprobacionesService } from './expense-comprobaciones.service';
import { ExpenseComprobacionesController } from './expense-comprobaciones.controller';
import { ComprobacionGastosGateway } from './comprobacion-gastos.gateway';

/**
 * GX.8 — Comprobación de Gastos (2ª etapa del ciclo). Captura la comprobación de un
 * gasto de Kepler (XA1001) + su archivo. Reusa `CloudinaryModule` (adjunto img/PDF).
 * Lee los gastos del espejo `analytics.expense_documents`; NO escribe a Kepler.
 * Gateway WS (Fase 2) avisa al autorizador cuando entra/cambia una captura.
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
  controllers: [ExpenseComprobacionesController],
  providers: [ExpenseComprobacionesService, ComprobacionGastosGateway],
  exports: [ExpenseComprobacionesService],
})
export class FinanceExpenseComprobacionesModule {}
