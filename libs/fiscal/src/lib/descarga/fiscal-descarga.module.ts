import { Module } from '@nestjs/common';
import { FiscalVaultModule } from '../vault/fiscal-vault.module';
import { FiscalJobsModule } from '../jobs/fiscal-jobs.module';
import { FiscalCfdiModule } from '../cfdi/fiscal-cfdi.module';
import { DescargaController } from './descarga.controller';
import { DescargaService } from './descarga.service';
import { DescargaOrchestratorService } from './descarga-orchestrator.service';
import { SatSoapService } from './sat-soap.service';
import { SAT_SOAP_PORT } from './sat-soap.port';

/**
 * FISCAL.4 (libs/fiscal) — Descarga masiva de CFDI (WS SAT).
 * Orquesta solicitud→verificación→paquete sobre fiscal.jobs (FISCAL.3), firmando
 * con la e.firma de la bóveda (FISCAL.2). El transporte SOAP está detrás del port
 * SAT_SOAP_PORT (impl de referencia SatSoapService, swapeable).
 */
@Module({
  imports: [FiscalVaultModule, FiscalJobsModule, FiscalCfdiModule],
  controllers: [DescargaController],
  providers: [
    DescargaService,
    DescargaOrchestratorService,
    SatSoapService,
    { provide: SAT_SOAP_PORT, useExisting: SatSoapService },
  ],
  exports: [DescargaService],
})
export class FiscalDescargaModule {}
