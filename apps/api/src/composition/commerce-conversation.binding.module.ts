import { Global, Injectable, Module } from '@nestjs/common';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import type {
  CommerceConversationPort,
  ConversationOrderDto,
  ConversationOrderResult,
  ConversationProductHit,
} from '@megadulces/contracts';
import {
  CommercialCatalogSearchModule,
  CommercialCatalogSearchService,
  CommercialHomeDeliveryModule,
  CommercialHomeDeliveryService,
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
  constructor(
    private readonly search: CommercialCatalogSearchService,
    private readonly homeDelivery: CommercialHomeDeliveryService,
  ) {}

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

  async createHomeDeliveryOrder(dto: ConversationOrderDto): Promise<ConversationOrderResult> {
    const order: any = await this.homeDelivery.createIntake({
      casual: { name: dto.casual.name, phone: dto.casual.phone },
      delivery_address: dto.delivery_address,
      delivery_channel: 'whatsapp',
      lines: dto.lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
    });
    return { order_id: order.id, code: order.code, total: Number(order.total) || 0 };
  }
}

@Global()
@Module({
  imports: [CommercialCatalogSearchModule, CommercialHomeDeliveryModule],
  providers: [
    CatalogSearchCommerceAdapter,
    { provide: COMMERCE_CONVERSATION_PORT, useExisting: CatalogSearchCommerceAdapter },
  ],
  exports: [COMMERCE_CONVERSATION_PORT],
})
export class CommerceConversationBindingModule {}
