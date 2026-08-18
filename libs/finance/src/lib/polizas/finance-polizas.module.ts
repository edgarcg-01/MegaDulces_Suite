import { Module } from '@nestjs/common';
import { PolizasController } from './polizas.controller';
import { PolizasService } from './polizas.service';
import { FinanceMaatModule } from '../maat/finance-maat.module';
import { FinanceJobsModule } from '../jobs/finance-jobs.module';

/**
 * PV.3 (Fase PV, ADR-041) — Auditor de Pólizas. Importa FinanceMaatModule para reusar
 * MaatDetectorService (el POST /scan dispara los detectores; TenantKnexService viene del
 * módulo raíz global) y FinanceJobsModule para delegar ese scan a background (COMM.7:
 * es el MISMO trabajo de 10 detectores que en la bandeja de hallazgos ya iba por job).
 * Se registra en AppModule dentro de multitenantModules.
 */
@Module({
  imports: [FinanceMaatModule, FinanceJobsModule],
  controllers: [PolizasController],
  providers: [PolizasService],
  exports: [PolizasService],
})
export class FinancePolizasModule {}
