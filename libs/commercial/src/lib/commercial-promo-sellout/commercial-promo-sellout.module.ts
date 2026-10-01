import { Module } from '@nestjs/common';
import { ScopeModule } from '@megadulces/platform-core';
import { PromoSelloutService } from './promo-sellout.service';
import { PromoSelloutController } from './promo-sellout.controller';

/**
 * `[MKT.6]` — Resultado de la activación: ¿la promoción movió la aguja?
 *
 * Módulo **aparte** del de los acuerdos (`[MKT.1]`) a propósito, no por arquitectura: los dos
 * se estaban escribiendo a la vez en este checkout compartido y meter archivos en la misma
 * carpeta garantizaba un conflicto. Comparten tablas, permisos y dominio; cuando `[MKT.1]`
 * llegue a `main`, fundirlos en un solo módulo es un movimiento de dos líneas y **queda
 * declarado como pendiente**, no como decisión de diseño.
 *
 * `ScopeModule` importado explícitamente: el servicio EXIGE `ScopeService` (no es `@Optional()`),
 * porque acá el alcance decide si se contesta o no. Sin el import, Nest no arranca — que es
 * mejor que arrancar con el corte apagado.
 *
 * Se wirea en `AppModule` bajo el toggle `ENABLE_MULTITENANT`, como el resto de `libs/commercial`.
 */
@Module({
  imports: [ScopeModule],
  controllers: [PromoSelloutController],
  providers: [PromoSelloutService],
  exports: [PromoSelloutService],
})
export class CommercialPromoSelloutModule {}
