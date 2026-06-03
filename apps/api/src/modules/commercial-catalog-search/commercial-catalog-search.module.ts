import { Module } from '@nestjs/common';
import { CommercialCatalogSearchController } from './commercial-catalog-search.controller';
import { CommercialCatalogSearchService } from './commercial-catalog-search.service';
import { TenantKnexService } from '@megadulces/platform-core';
import { AiProductMatcherModule } from '../ai-product-matcher/ai-product-matcher.module';
import { CommercialRecommendationsModule } from '../commercial-recommendations/commercial-recommendations.module';

/**
 * Búsqueda semántica del catálogo scoped al price_list del customer.
 *
 * `POST /api/commercial/catalog/search`
 *   Body: { query, limit? }
 *   Embed query con Voyage (mode=query) → KNN cosine sobre products.embedding
 *   filtrando por commercial.product_prices.price_list_id del customer.
 *
 * Reusa `EmbeddingsService` exportado por `AiProductMatcherModule` (Fase K).
 */
@Module({
  imports: [AiProductMatcherModule, CommercialRecommendationsModule],
  controllers: [CommercialCatalogSearchController],
  providers: [CommercialCatalogSearchService, TenantKnexService],
})
export class CommercialCatalogSearchModule {}
