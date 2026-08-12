import { Module } from '@nestjs/common';
import { FinanceBankService } from './finance-bank.service';
import { FinanceBankController } from './finance-bank.controller';
import { SheetSyncService } from './sheet-sync.service';

/**
 * CB.2 — Conciliación bancaria (ADR-033). Tablero de bancos sobre `finance.bank_*`:
 * cuentas, catálogo de categorías, estados de cuenta, movimientos y CONCENTRADO,
 * más reclasificación. TenantKnexService/TenantContextService son globales
 * (platform-core) → no requiere imports extra.
 *
 * CB.23 — SheetSyncService: sync del workbook maestro (Google Sheet) vía export
 * público (cron @3min + botón). Usa el @Cron de @nestjs/schedule (ScheduleModule
 * está en el root del API).
 */
@Module({
  controllers: [FinanceBankController],
  providers: [FinanceBankService, SheetSyncService],
  exports: [FinanceBankService],
})
export class FinanceBankModule {}
