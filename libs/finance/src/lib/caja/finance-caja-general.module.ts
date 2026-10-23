import { Module } from '@nestjs/common';
import { CajaGeneralService } from './caja-general.service';
import { CajaGeneralController } from './caja-general.controller';
import { CashLedgerService } from './cash-ledger.service';
import { CashLedgerController } from './cash-ledger.controller';
import { CajaAutofillService } from './caja-autofill.service';
import { CashCutService } from './cash-cut.service';
import { CajaFechaFuturaScannerService } from './caja-fecha-futura-scanner.service';
import { CajaCorteAbiertoScannerService } from './caja-corte-abierto-scanner.service';
import { CajaAutofillRefreshService } from './caja-autofill-refresh.service';
import { CajaAutollenadoService } from './caja-autollenado.service';
import { CajaRealtimeModule } from './caja-realtime.module';
import { CajaControlService } from './caja-control.service';
import { CajaControlController } from './caja-control.controller';
import { CajaArqueoService } from './caja-arqueo.service';
import { CajaArqueoController } from './caja-arqueo.controller';
// `[CG.201]` La firma por teléfono: el pedido es una fila y el teléfono habla por HTTP.
import { CajaFirmaService } from './caja-firma.service';
import { CajaFirmaController, CajaFirmaPublicController } from './caja-firma.controller';
// `[CGA-A.51]` El retiro de CAOS que se lleva una persona (ADR-101).
import { CajaCustodiaService } from './caja-custodia.service';
import { CajaCustodiaController } from './caja-custodia.controller';

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
  controllers: [CajaGeneralController, CashLedgerController, CajaControlController, CajaArqueoController,
    CajaFirmaController, CajaFirmaPublicController, CajaCustodiaController],
  // [CG.25] El vigilante de la fecha adelantada: avisa, y cuando Kepler corrige, sigue. Va acá y
  // no en el controller porque corre por `@Cron`, sin request — con su propia advertencia de RLS.
  // [CG.141] El carril que refresca `mv_caja_autofill_entidad`. Va acá, y NO en el array
  // genérico de `AnalyticsRefreshService`: aquél refresca sin fijar `app.tenant_id`, y esta
  // matvista lee una vista filtrada por `current_tenant_id()` — refrescarla así la VACÍA, que
  // es exactamente como nació.
  // [CGP-L.10] El sensor del corte abierto: el del 12-oct estuvo trabado tres jornadas y nadie avisó.
  // [CG.190] El autollenado sin supervisión: confirma solo lo que el resolvedor ya resuelve, por
  // el MISMO `crearLote()` de la pantalla. Va acá porque corre por `@Cron`, sin request — con su
  // propio scope de tenant (RLS forzado) y su cuenta de servicio. ⛔ Arranca APAGADO:
  // `ENABLE_CAJA_AUTOLLENADO=true` lo prende, y la migración de la cuenta de servicio va antes.
  providers: [CajaGeneralService, CashLedgerService, CajaAutofillService, CashCutService,
    CajaFechaFuturaScannerService, CajaCorteAbiertoScannerService, CajaControlService, CajaAutofillRefreshService,
    CajaAutollenadoService, CajaArqueoService, CajaFirmaService, CajaCustodiaService],
  exports: [CajaGeneralService, CashLedgerService, CajaAutofillService, CashCutService,
    CajaFechaFuturaScannerService, CajaCorteAbiertoScannerService, CajaControlService, CajaAutofillRefreshService,
    CajaAutollenadoService, CajaArqueoService, CajaCustodiaService],
})
export class FinanceCajaGeneralModule {}
