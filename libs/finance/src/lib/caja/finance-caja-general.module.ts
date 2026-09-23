import { Module } from '@nestjs/common';
import { CajaGeneralService } from './caja-general.service';
import { CajaGeneralController } from './caja-general.controller';
import { CashLedgerService } from './cash-ledger.service';
import { CashLedgerController } from './cash-ledger.controller';
import { CajaAutofillService } from './caja-autofill.service';
import { CashCutService } from './cash-cut.service';
import { CajaRealtimeModule } from './caja-realtime.module';

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
  controllers: [CajaGeneralController, CashLedgerController],
  providers: [CajaGeneralService, CashLedgerService, CajaAutofillService, CashCutService],
  exports: [CajaGeneralService, CashLedgerService, CajaAutofillService, CashCutService],
})
export class FinanceCajaGeneralModule {}
