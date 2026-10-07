import { Module } from '@nestjs/common';
import { CommercialQuotesController } from './commercial-quotes.controller';
import { CommercialQuotesService } from './commercial-quotes.service';
import { QuotePricingService } from './quote-pricing.service';

/**
 * `[E.12]` — Submódulo de Telemarketing: cotizaciones de mayoreo.
 *
 * Expone:
 *   - GET  /api/commercial/quotes
 *   - GET  /api/commercial/quotes/summary
 *   - GET  /api/commercial/quotes/:id
 *   - POST /api/commercial/quotes
 *   - POST /api/commercial/quotes/:id/cancel
 *   - POST /api/commercial/quotes/price-preview   [COT.1] precio sin guardar, con desglose
 *   - POST /api/commercial/quotes/:id/lines       [COT.1] agrega renglon (precio del servidor)
 *   - DELETE /api/commercial/quotes/:id/lines/:lineId
 *
 * ⚠️ `summary` va declarada ANTES de `:id` en el controller: al revés, Nest resolvería
 * `/summary` contra el parámetro y devolvería un 404 de "cotización no encontrada". Es la misma
 * trampa que cazó `no-asociados` en Fase LC.
 *
 * Todavía NO expone: carga de renglones, envío al cliente, PDF y conversión a pedido. Eso es
 * E.12.1–E.12.4 y está declarado como pendiente, no insinuado como hecho.
 */
@Module({
  controllers: [CommercialQuotesController],
  providers: [CommercialQuotesService, QuotePricingService],
  exports: [CommercialQuotesService, QuotePricingService],
})
export class CommercialQuotesModule {}
