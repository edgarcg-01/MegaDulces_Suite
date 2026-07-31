import { Module } from '@nestjs/common';
import { PolizasController } from './polizas.controller';
import { PolizasService } from './polizas.service';
import { FinanceMaatModule } from '../maat/finance-maat.module';

/**
 * PV.3 (Fase PV, ADR-041) — Auditor de Pólizas. Importa FinanceMaatModule para reusar
 * MaatDetectorService (el POST /scan dispara los detectores; TenantKnexService viene del
 * módulo raíz global). Se registra en AppModule dentro de multitenantModules.
 */
@Module({
  imports: [FinanceMaatModule],
  controllers: [PolizasController],
  providers: [PolizasService],
  exports: [PolizasService],
})
export class FinancePolizasModule {}
