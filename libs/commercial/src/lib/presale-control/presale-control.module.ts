import { Module } from '@nestjs/common';
import { CommercialSalesDocumentsModule } from '../commercial-sales-documents/commercial-sales-documents.module';
import { PresaleControlController } from './presale-control.controller';
import { PresaleControlService } from './presale-control.service';
import { LoadGuideService } from './load-guide.service';
import { PresaleFieldController, PresaleGuidesController } from './load-guide.controller';

/**
 * `[MCP.1]` Mesa de Control de Preventa (Fase MCP, ADR-089) + `[MCP.5]` guías de carga.
 * TenantKnexService, TenantContextService y ScopeService son globales.
 *
 * Importa `CommercialSalesDocumentsModule` por `AnexoVentaService.renderPdf`: el Chromium
 * COMPARTIDO con su timer de inactividad (lanzar otro duplicaría ~150 MB), igual que la Guía de
 * Cobranza y el ticket carta.
 */
@Module({
  imports: [CommercialSalesDocumentsModule],
  controllers: [PresaleControlController, PresaleFieldController, PresaleGuidesController],
  providers: [PresaleControlService, LoadGuideService],
  exports: [PresaleControlService, LoadGuideService],
})
export class PresaleControlModule {}
