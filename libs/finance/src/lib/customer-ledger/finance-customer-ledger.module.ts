import { Module } from '@nestjs/common';
import { CustomerLedgerService } from './customer-ledger.service';
import { CustomerLedgerController } from './customer-ledger.controller';

/**
 * Fase CXC (ADR-048) — Cartera de clientes / Partidas vivas (CxC). Lee el espejo
 * read-only `analytics.customer_receivables` (derivado de `md.kdue`). Sin dependencias
 * externas (solo TenantKnexService, provisto globalmente). No escribe a Kepler.
 */
@Module({
  controllers: [CustomerLedgerController],
  providers: [CustomerLedgerService],
  exports: [CustomerLedgerService],
})
export class FinanceCustomerLedgerModule {}
