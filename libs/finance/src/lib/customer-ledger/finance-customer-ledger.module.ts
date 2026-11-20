import { Module } from '@nestjs/common';
import { PgListenService } from '@megadulces/platform-core';
import { CustomerLedgerService } from './customer-ledger.service';
import { CarteraPorEventoService } from './cartera-por-evento.service';
import { FinanceCollectionDepositsModule } from '../collection-deposits/finance-collection-deposits.module';
import { CustomerLedgerController } from './customer-ledger.controller';
import { CustomerReceivablesScannerService } from './customer-receivables-scanner.service';
import { EstadoCuentaClienteDocument } from './estado-cuenta-cliente.document';
import { EstadoCuentaPublicoController } from './estado-cuenta-publico.controller';
import { CarteraTelefonosController } from './cartera-telefonos.controller';
import { CarteraTelefonosService } from './cartera-telefonos.service';
import { KeplerTelefonoClienteAdapter } from './kepler-telefono-cliente.adapter';

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
  // [CC.20] El estado de cuenta imprime el QR del enlace de depósito del cliente (CustomerDepositsService).
  imports: [FinanceCollectionDepositsModule],
  // [CC.20.2] El cliente descarga su estado de cuenta desde su enlace personal (pública, autorizada por el token).
  // [CXC.48] Los teléfonos de la cartera: el del cliente se escribe en Kepler, el del vendedor en la Suite.
  controllers: [CustomerLedgerController, EstadoCuentaPublicoController, CarteraTelefonosController],
  providers: [CustomerLedgerService, CustomerReceivablesScannerService, EstadoCuentaClienteDocument,
    PgListenService, CarteraPorEventoService, CarteraTelefonosService, KeplerTelefonoClienteAdapter],
  exports: [CustomerLedgerService, CustomerReceivablesScannerService],
})
export class FinanceCustomerLedgerModule {}
