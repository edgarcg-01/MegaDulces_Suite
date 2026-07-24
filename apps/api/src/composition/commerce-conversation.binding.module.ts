import { Global, Injectable, Module } from '@nestjs/common';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import type {
  CommerceConversationPort,
  ConversationProductHit,
} from '@megadulces/contracts';
import {
  CommercialCatalogSearchModule,
  CommercialCatalogSearchService,
} from '@megadulces/commercial';

/**
 * Composition root del Port conversacional (ADR-034, Fase F.2).
 *
 * Liga COMMERCE_CONVERSATION_PORT (contracts, inyectado por el orquestador de
 * WhatsApp) a la búsqueda de catálogo de commercial. Único lugar que conoce
 * ambos lados → libs/whatsapp no importa commercial. @Global para que el token
 * sea resoluble desde WhatsAppModule. El orquestador lo inyecta @Optional().
 *
 * Cliente casual de WhatsApp = sin cartera → `search` cae al price_list default
 * del tenant (customerId null). El precio devuelto es el autoritativo (ADR-016).
 */
@Injectable()
class CatalogSearchCommerceAdapter implements CommerceConversationPort {
  constructor(private readonly search: CommercialCatalogSearchService) {}

  async searchProducts(query: string, opts?: { limit?: number }): Promise<ConversationProductHit[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const { results } = await this.search.search({ query: q, limit: opts?.limit ?? 5, customerId: null });
    return results
      .filter((r) => r.price != null)
      .map((r) => ({
        product_id: r.product_id,
        name: r.product_name,
        brand_name: r.brand_name ?? null,
        unit_price: Number(r.price),
        min_qty: Number(r.min_qty) || 1,
      }));
  }
}

@Global()
@Module({
  imports: [CommercialCatalogSearchModule],
  providers: [
    CatalogSearchCommerceAdapter,
    { provide: COMMERCE_CONVERSATION_PORT, useExisting: CatalogSearchCommerceAdapter },
  ],
  exports: [COMMERCE_CONVERSATION_PORT],
})
export class CommerceConversationBindingModule {}
