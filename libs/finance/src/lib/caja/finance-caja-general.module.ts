import { Module } from '@nestjs/common';
import { CajaGeneralService } from './caja-general.service';
import { CajaGeneralController } from './caja-general.controller';
import { CashLedgerService } from './cash-ledger.service';
import { CashLedgerController } from './cash-ledger.controller';
import { CajaAutofillService } from './caja-autofill.service';
import { CashCutService } from './cash-cut.service';
import { CajaFechaFuturaScannerService } from './caja-fecha-futura-scanner.service';
import { CajaAutofillRefreshService } from './caja-autofill-refresh.service';
import { CajaRealtimeModule } from './caja-realtime.module';
import { CajaControlService } from './caja-control.service';
import { CajaControlController } from './caja-control.controller';

/**
 * Caja General. Dos mitades que conviven durante el traslape (ADR-070):
 *
 *   · LECTURA (CG.1-CG.7) — `CajaGeneralService`/`Controller`, read-only sobre
 *     `analytics.caja_*`, el espejo del Access `Control`. Sigue vivo hasta el corte (CG.16).
 *   · ESCRITURA (CG.13/CG.17) — `CashLedgerService`/`Controller` + `CajaAutofillService`:
 *     la plataforma como FUENTE PRINCIPAL del efectivo, con el par cuenta/concepto de Kepler
 *     obligatorio y el motor de autorrelleno.
 *
 * TenantKnexService/TenantContextService vienen del core global.
 */
@Module({
  // CG.23.2 — el tiempo real va en su propio módulo (namespace `/caja` + puente NOTIFY→WS).
  imports: [CajaRealtimeModule],
  controllers: [CajaGeneralController, CashLedgerController, CajaControlController],
  // [CG.25] El vigilante de la fecha adelantada: avisa, y cuando Kepler corrige, sigue. Va acá y
  // no en el controller porque corre por `@Cron`, sin request — con su propia advertencia de RLS.
  // [CG.141] El carril que refresca `mv_caja_autofill_entidad`. Va acá, y NO en el array
  // genérico de `AnalyticsRefreshService`: aquél refresca sin fijar `app.tenant_id`, y esta
  // matvista lee una vista filtrada por `current_tenant_id()` — refrescarla así la VACÍA, que
  // es exactamente como nació.
  providers: [CajaGeneralService, CashLedgerService, CajaAutofillService, CashCutService,
    CajaFechaFuturaScannerService, CajaControlService, CajaAutofillRefreshService],
  exports: [CajaGeneralService, CashLedgerService, CajaAutofillService, CashCutService,
    CajaFechaFuturaScannerService, CajaControlService, CajaAutofillRefreshService],
})
export class FinanceCajaGeneralModule {}
