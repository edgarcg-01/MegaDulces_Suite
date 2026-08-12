import { Module } from '@nestjs/common';
import { CajaGeneralService } from './caja-general.service';
import { CajaGeneralController } from './caja-general.controller';

/**
 * Fase CG.3 — Caja General (Tesorería). Read-only sobre analytics.caja_* (espejo del
 * sistema Access de Finanzas, cargado por import-caja-general.js). TenantKnexService/
 * TenantContextService vienen del core global.
 */
@Module({
  controllers: [CajaGeneralController],
  providers: [CajaGeneralService],
  exports: [CajaGeneralService],
})
export class FinanceCajaGeneralModule {}
