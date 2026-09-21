import { Module } from '@nestjs/common';
import { CommercialQuotesController } from './commercial-quotes.controller';
import { CommercialQuotesService } from './commercial-quotes.service';

/**
 * `[E.12]` — Submódulo de Telemarketing: cotizaciones de mayoreo.
 *
 * Expone:
 *   - GET  /api/commercial/quotes
 *   - GET  /api/commercial/quotes/summary
 *   - GET  /api/commercial/quotes/:id
 *   - POST /api/commercial/quotes
 *   - POST /api/commercial/quotes/:id/cancel
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
  providers: [CommercialQuotesService],
  exports: [CommercialQuotesService],
})
export class CommercialQuotesModule {}
