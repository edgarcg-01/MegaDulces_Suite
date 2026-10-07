import { Module } from '@nestjs/common';
import { FiscalListasController } from './fiscal-listas.controller';
import { FiscalListasService } from './fiscal-listas.service';
import { SatListIngestService } from './sat-list-ingest.service';
import { SatListCrossService } from './sat-list-cross.service';
import { RfcValidationService } from './rfc-validation.service';
import { FiscalListasScannerService } from './fiscal-listas-scanner.service';
import { FiscalFindingsBridgeService } from './fiscal-findings-bridge.service';

/**
 * FISCAL.0 + FISCAL.1 (libs/fiscal) — Motor de listas SAT + validación de RFC.
 *
 * Detecta proveedores del tenant en listas negras del SAT (69-B EFOS, Art. 69)
 * y RFCs con problema estructural, cruzando dato público contra
 * analytics.expense_documents. Motor determinista (SQL puro), sin LLM. Bandejas
 * con triage humano. Extensible a N listas por config (sat-lists.config.ts).
 *
 * Depende solo de platform-core (TenantKnexService / RLS / KNEX_NEW_DB).
 * Próximo (decisión Edgar): consolidar hallazgos en finance.findings (Maat).
 */
@Module({
  controllers: [FiscalListasController],
  providers: [
    FiscalListasService, SatListIngestService, SatListCrossService,
    RfcValidationService, FiscalListasScannerService, FiscalFindingsBridgeService,
  ],
  exports: [FiscalListasService, SatListIngestService, SatListCrossService, RfcValidationService, FiscalFindingsBridgeService],
})
export class FiscalListasModule {}
