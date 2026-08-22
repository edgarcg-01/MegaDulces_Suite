import { Module } from '@nestjs/common';
import { CommercialSalesDocumentsService } from './commercial-sales-documents.service';
import { CommercialSalesDocumentsController } from './commercial-sales-documents.controller';
import { AnexoVentaService } from './anexo-venta.service';

/**
 * AX — Documentos de venta al cliente (anexo imprimible + pagaré).
 * Sólo lectura sobre las vistas en vivo `analytics.erp_sales_invoices` / `_lines`.
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 */
@Module({
  controllers: [CommercialSalesDocumentsController],
  providers: [CommercialSalesDocumentsService, AnexoVentaService],
  exports: [CommercialSalesDocumentsService, AnexoVentaService],
})
export class CommercialSalesDocumentsModule {}
