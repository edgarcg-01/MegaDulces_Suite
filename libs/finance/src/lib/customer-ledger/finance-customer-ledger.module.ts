import { Module } from '@nestjs/common';
import { CustomerLedgerService } from './customer-ledger.service';
import { CustomerLedgerController } from './customer-ledger.controller';
import { CustomerReceivablesScannerService } from './customer-receivables-scanner.service';

/**
 * Fase CXC (ADR-048) — Cartera de clientes / Partidas vivas (CxC). Lee el espejo
 * read-only `analytics.customer_receivables` (derivado de `md.kdue`). El scanner
 * (CXC.7) empuja riesgo a la bandeja de Maat vía FINANCE_FINDINGS_SINK_PORT (inyección
 * @Optional; el binding vive en el composition root). No escribe a Kepler.
 */
@Module({
  controllers: [CustomerLedgerController],
  providers: [CustomerLedgerService, CustomerReceivablesScannerService],
  exports: [CustomerLedgerService, CustomerReceivablesScannerService],
})
export class FinanceCustomerLedgerModule {}
