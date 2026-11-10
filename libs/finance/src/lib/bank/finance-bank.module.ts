import { Module } from '@nestjs/common';
import { FinanceBankService } from './finance-bank.service';
import { FinanceBankController } from './finance-bank.controller';
import { SheetSyncService } from './sheet-sync.service';
import { BancosRealtimeModule } from './bancos-realtime.module';
import { FinanceJobsModule } from '../jobs/finance-jobs.module';
import { CajaRealtimeModule } from '../caja/caja-realtime.module';
import { BankReconPorAvisoService } from './bank-recon-aviso.service';
import { EstadoDeCuentaService } from './estado-de-cuenta/estado-de-cuenta.service';
import { EstadoDeCuentaController } from './estado-de-cuenta/estado-de-cuenta.controller';
import { ComisionesKeplerService } from './comisiones-kepler/comisiones-kepler.service';
import { ComisionesKeplerController } from './comisiones-kepler/comisiones-kepler.controller';

/**
 * CB.2 — Conciliación bancaria (ADR-033). Tablero de bancos sobre `finance.bank_*`:
 * cuentas, catálogo de categorías, estados de cuenta, movimientos y CONCENTRADO,
 * más reclasificación. TenantKnexService/TenantContextService son globales
 * (platform-core) → no requiere imports extra.
 *
 * CB.23 — SheetSyncService: sync del workbook maestro (Google Sheet) vía export
 * público (cron @3min + botón). Usa el @Cron de @nestjs/schedule (ScheduleModule
 * está en el root del API).
 *
 * CB.53 — BankReconPorAvisoService: la conciliación corre al llegar el dato (oyente de
 * `caja_fuente`), no por reloj. Se registra acá, pero **sólo escucha en el worker**
 * (`WORKER=true`): en los pods de `api` se queda inerte y lo dice en el log.
 *
 * CB.58 — EstadoDeCuentaService/Controller: subir el estado de cuenta descargado de la banca
 * (revisar → confirmar) a `finance.bank_statement_files/lines`. Sólo pide los dos globales de
 * platform-core (`TenantKnexService`, `TenantContextService`).
 *
 * CB.62 — ComisionesKeplerService/Controller: la propuesta de las comisiones de la terminal que irían a
 * Kepler (sólo lectura). Mismos dos globales.
 *
 * ⛔ **`CajaRealtimeModule` se importa por `PgListenService`, y NO se provee acá.** No es global:
 * lo exporta ese módulo a propósito —*«para que el autollenado se cuelgue del MISMO canal con la
 * MISMA conexión»* (`[CG.197]`)—. Declararlo en los `providers` de este módulo compila igual y
 * abre una **segunda conexión `LISTEN`** contra prod para escuchar exactamente el mismo aviso.
 * ⚠️ Olvidarlo tampoco falla al compilar: **tira el arranque de Nest** con
 * `UnknownDependenciesException`, que es lo que pasó el 2026-10-21 (el typecheck estaba limpio).
 */
@Module({
  imports: [BancosRealtimeModule, FinanceJobsModule, CajaRealtimeModule],
  controllers: [FinanceBankController, EstadoDeCuentaController, ComisionesKeplerController],
  providers: [FinanceBankService, SheetSyncService, BankReconPorAvisoService, EstadoDeCuentaService, ComisionesKeplerService],
  exports: [FinanceBankService],
})
export class FinanceBankModule {}
