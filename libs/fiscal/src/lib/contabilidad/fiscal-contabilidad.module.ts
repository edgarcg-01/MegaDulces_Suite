import { Module } from '@nestjs/common';
import { ContabilidadElectronicaService } from './contabilidad-electronica.service';
import { ContabilidadController } from './contabilidad.controller';

/**
 * FISCAL.9 (libs/fiscal) — Contabilidad Electrónica (XMLs SAT: catálogo + balanza).
 * Genera on-the-fly desde analytics.ledger_monthly. Sin tablas nuevas ni WS.
 */
@Module({
  controllers: [ContabilidadController],
  providers: [ContabilidadElectronicaService],
  exports: [ContabilidadElectronicaService],
})
export class FiscalContabilidadModule {}
