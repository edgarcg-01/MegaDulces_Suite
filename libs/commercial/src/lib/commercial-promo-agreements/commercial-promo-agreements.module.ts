import { Module } from '@nestjs/common';
import { PromoAgreementsService } from './promo-agreements.service';
import { PromoAgreementsController } from './promo-agreements.controller';

/**
 * `[MKT.1]` — Acuerdos con proveedor (formato MKTN001) y su expediente por plaza.
 *
 * Sin `imports`: `TenantKnexService`, `TenantContextService` y `ScopeService` son globales.
 *
 * ⚠️ `ScopeService` NO es opcional acá: es lo que decide si la plaza ve un acuerdo o no. Un
 * módulo que lo dejara `@Optional()` tendría que elegir entre abrirse (fail-open) o romperse, y
 * las dos son peores que exigirlo.
 *
 * Se wirea en `AppModule` bajo el toggle `ENABLE_MULTITENANT`, como el resto de `libs/commercial`.
 */
@Module({
  controllers: [PromoAgreementsController],
  providers: [PromoAgreementsService],
  exports: [PromoAgreementsService],
})
export class CommercialPromoAgreementsModule {}
