import { Module } from '@nestjs/common';
import { CortesSucursalesService } from './cortes-sucursales.service';
import { CortesSucursalesController } from './cortes-sucursales.controller';

/**
 * `[CSU.1]` Cortes/Sucursales. Read-only sobre `kepler_ods.*` + `analytics.cash_cuts` /
 * `analytics.erp_collections` (derive-no-copy). TenantKnexService/TenantContextService vienen
 * del core global.
 */
@Module({
  controllers: [CortesSucursalesController],
  providers: [CortesSucursalesService],
  exports: [CortesSucursalesService],
})
export class FinanceCortesSucursalesModule {}
