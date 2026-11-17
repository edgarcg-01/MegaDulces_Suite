import { Module } from '@nestjs/common';
import { PgListenService } from '@megadulces/platform-core';
import { CustomerLedgerService } from './customer-ledger.service';
import { CarteraPorEventoService } from './cartera-por-evento.service';
import { CustomerLedgerController } from './customer-ledger.controller';
import { CustomerReceivablesScannerService } from './customer-receivables-scanner.service';
import { EstadoCuentaClienteDocument } from './estado-cuenta-cliente.document';

/**
 * Fase CXC (ADR-048) — Cartera de clientes / Partidas vivas (CxC). Lee el espejo
 * read-only `analytics.customer_receivables` (derivado de `md.kdue`). El scanner
 * (CXC.7) empuja riesgo a la bandeja de Maat vía FINANCE_FINDINGS_SINK_PORT (inyección
 * @Optional; el binding vive en el composition root). No escribe a Kepler.
 *
 * `[CXC.21]` `CarteraPorEventoService` escucha `cartera_sucia`: `PgListenService` NO es global, cada dominio que
 * escucha lo provee (como CommercialAnalyticsModule con la existencia). La conexión LISTEN sólo se abre si alguien
 * escucha, y el que drena sólo escucha en el worker.
 */
@Module({
  controllers: [CustomerLedgerController],
  providers: [CustomerLedgerService, CustomerReceivablesScannerService, EstadoCuentaClienteDocument,
    PgListenService, CarteraPorEventoService],
  exports: [CustomerLedgerService, CustomerReceivablesScannerService],
})
export class FinanceCustomerLedgerModule {}
