import { Module } from '@nestjs/common';
import { BancosRealtimeModule } from '../bank/bancos-realtime.module';
import { FinanceJobsService } from './finance-jobs.service';
import { FinanceJobsController } from './finance-jobs.controller';

/**
 * COMM-P0 — Trabajos largos de Finanzas fuera del request (202 + WS `finance_job`).
 * Lo importan los módulos que disparan motores largos (Bancos, Maat). Importa
 * `BancosRealtimeModule` porque el namespace `/bancos` es el canal WS de Finanzas.
 */
@Module({
  imports: [BancosRealtimeModule],
  controllers: [FinanceJobsController],
  providers: [FinanceJobsService],
  exports: [FinanceJobsService],
})
export class FinanceJobsModule {}
