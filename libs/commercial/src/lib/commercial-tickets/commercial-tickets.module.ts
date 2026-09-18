import { Module } from '@nestjs/common';
import { CommercialTicketsService } from './commercial-tickets.service';
import { CommercialTicketsController } from './commercial-tickets.controller';
import { TicketCartaService } from './ticket-carta.service';
import { CommercialSalesDocumentsModule } from '../commercial-sales-documents/commercial-sales-documents.module';

/**
 * Fase TK — Tickets de venta: buscar cualquier folio y reimprimirlo.
 *
 * Sólo lectura. Importa `CommercialSalesDocumentsModule` —y no duplica sus servicios— para
 * reusar dos cosas que ya están resueltas allá y que no conviene tener por duplicado:
 *   · `AnexoVentaService.renderPdf()` → el Chromium COMPARTIDO con su timer de inactividad.
 *     Un segundo navegador serían ~150 MB más, que es justo lo que ADR-043 evita.
 *   · `CommercialSalesDocumentsService.emisorFiscal()` → la identidad fiscal sale de
 *     `fiscal.issuer_config`, nunca de una constante, y con su caché.
 *
 * `TenantKnexService` / `TenantContextService` / `ScopeService` vienen del módulo global de
 * platform-core.
 */
@Module({
  imports: [CommercialSalesDocumentsModule],
  controllers: [CommercialTicketsController],
  providers: [CommercialTicketsService, TicketCartaService],
  exports: [CommercialTicketsService, TicketCartaService],
})
export class CommercialTicketsModule {}
