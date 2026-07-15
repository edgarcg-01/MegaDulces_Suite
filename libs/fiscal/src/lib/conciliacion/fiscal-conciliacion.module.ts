import { Module } from '@nestjs/common';
import { ConciliacionService } from './conciliacion.service';
import { PolizaCruceService } from './poliza-cruce.service';
import { ConciliacionController } from './conciliacion.controller';
import { FiscalConciliacionScannerService } from './fiscal-conciliacion-scanner.service';

/**
 * FISCAL.5 (libs/fiscal) — Conciliación.
 *  5.1 PUE/PPD ↔ REP (ConciliacionService) sobre fiscal.cfdis + cfdi_payment_links.
 *  5.2 CFDI ↔ póliza (PolizaCruceService) heurística vs analytics.expense_documents.
 * Empujan hallazgos a Maat vía FINANCE_FINDINGS_SINK_PORT (@Global).
 */
@Module({
  controllers: [ConciliacionController],
  providers: [ConciliacionService, PolizaCruceService, FiscalConciliacionScannerService],
  exports: [ConciliacionService, PolizaCruceService],
})
export class FiscalConciliacionModule {}
