import { Module } from '@nestjs/common';
import { EstatusService } from './estatus.service';
import { EstatusController } from './estatus.controller';
import { EstatusScannerService } from './estatus-scanner.service';
import { SatEstatusService } from './sat-estatus.service';
import { SAT_ESTATUS_PORT } from './sat-estatus.port';

/**
 * FISCAL.6 (libs/fiscal) — Validación de estatus CFDI ante el SAT (vigente/cancelado).
 * WS público ConsultaCFDIService (sin e.firma) detrás del port SAT_ESTATUS_PORT.
 * Actualiza fiscal.cfdis.estatus_sat y empuja hallazgos de CFDI cancelado a Maat.
 */
@Module({
  controllers: [EstatusController],
  providers: [
    EstatusService,
    EstatusScannerService,
    SatEstatusService,
    { provide: SAT_ESTATUS_PORT, useExisting: SatEstatusService },
  ],
  exports: [EstatusService],
})
export class FiscalEstatusModule {}
