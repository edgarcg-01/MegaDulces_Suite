import { Module } from '@nestjs/common';
import { PgListenService } from '@megadulces/platform-core';
import { CommercialSalesDocumentsService } from './commercial-sales-documents.service';
import { CommercialSalesDocumentsController } from './commercial-sales-documents.controller';
import { AnexoVentaService } from './anexo-venta.service';
import { GuiaCobranzaService } from './guia-cobranza.service';
import { TlmkRevisionService } from './tlmk-revision.service';
import { CommercialAlertsModule } from '../commercial-alerts/commercial-alerts.module';

/**
 * AX — Facturación de Telemarketing (anexo imprimible + pagaré).
 * Sólo lectura sobre las vistas en vivo `analytics.erp_sales_invoices` / `_lines`.
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 *
 * `[AX.22]` `TlmkRevisionService` escucha `caja_fuente`: `PgListenService` NO es global, cada
 * dominio que escucha lo provee (como RH y CAOS) — una conexión LISTEN dedicada por pod de API.
 * `CommercialAlertsModule` por `AlertsService` (el aviso a quien levantó la cotización).
 * `FINANCE_FINDINGS_SINK_PORT` llega del composition root (@Optional: sin él, no corre y lo dice).
 */
@Module({
  imports: [CommercialAlertsModule],
  controllers: [CommercialSalesDocumentsController],
  providers: [CommercialSalesDocumentsService, AnexoVentaService, GuiaCobranzaService, PgListenService, TlmkRevisionService],
  exports: [CommercialSalesDocumentsService, AnexoVentaService, GuiaCobranzaService],
})
export class CommercialSalesDocumentsModule {}
