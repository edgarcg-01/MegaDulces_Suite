import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import type {
  CommerceConversationPort,
  ConversationCustomer,
  ConversationOrderDto,
  ConversationOrderResult,
  ConversationProductHit,
} from '@megadulces/contracts';
import { TenantKnexService, normalizeMxPhone } from '@megadulces/platform-core';
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
  private readonly logger = new Logger(CatalogSearchCommerceAdapter.name);

  constructor(
    private readonly search: CommercialCatalogSearchService,
    private readonly homeDelivery: CommercialHomeDeliveryService,
    private readonly tk: TenantKnexService,
  ) {}

  /**
   * FIQ.0 (ADR-036) — Reconoce al cliente por su teléfono. Normaliza a MSISDN
   * canónico y matchea contra `customers.whatsapp` normalizado (índice funcional
   * `ix_customers_whatsapp_norm`), con fallback a `phone`. Prefiere el cliente de
   * cartera (no casual) y el más reciente. El MOTOR resuelve; el LLM solo saluda.
   */
  async resolveCustomerByPhone(phone: string): Promise<ConversationCustomer | null> {
    const canonical = normalizeMxPhone(phone);
    if (!canonical) return null;
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.customers')
        .whereNull('deleted_at')
        .andWhere((b: any) => {
          b.whereRaw('public.mx_normalize_phone(whatsapp) = ?', [canonical]).orWhereRaw(
            'public.mx_normalize_phone(phone) = ?',
            [canonical],
          );
        })
        // Cartera formal antes que casual; luego el más reciente.
        .orderBy('is_casual', 'asc')
        .orderBy('created_at', 'desc')
        .first('id', 'name', 'is_casual', 'default_price_list_id');
      if (!row) return null;
      return {
        customer_id: row.id,
        name: row.name,
        is_casual: !!row.is_casual,
        default_price_list_id: row.default_price_list_id ?? null,
      };
    });
  }

  async searchProducts(query: string, opts?: { limit?: number }): Promise<ConversationProductHit[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const { results } = await this.search.search({ query: q, limit: opts?.limit ?? 5, customerId: null });
    const priced = results.filter((r) => r.price != null);
    if (priced.length === 0) return [];

    // F.5 — Enriquecer con existencia (almacén de surtido = default activo) +
    // empaque (factor_sale = piezas por caja). El bot NUNCA promete agotados y
    // maneja pieza/paquete. Todo cuantitativo sale de acá, no del LLM (ADR-016).
    const ids = priced.map((r) => r.product_id);
    const meta = await this.tk.run(async (trx) => {
      const rows = await trx.raw(
        `SELECT p.id AS product_id,
                GREATEST(COALESCE(p.factor_sale, 1), 1) AS pieces_per_package,
                COALESCE(s.qty, 0) AS stock_pieces
           FROM catalog.products p
           LEFT JOIN LATERAL (
             SELECT (st.quantity - COALESCE(st.reserved_quantity, 0)) AS qty
               FROM commercial.stock st
               JOIN commercial.warehouses w
                 ON w.id = st.warehouse_id AND w.tenant_id = st.tenant_id
              WHERE st.product_id = p.id AND st.tenant_id = p.tenant_id
                AND w.active = true AND w.deleted_at IS NULL
              ORDER BY w.is_default DESC, w.name ASC
              LIMIT 1
           ) s ON true
          WHERE p.tenant_id = public.current_tenant_id()
            AND p.id = ANY(?)`,
        [ids],
      );
      const m = new Map<string, { pieces_per_package: number; stock_pieces: number }>();
      for (const r of rows.rows) {
        m.set(r.product_id, {
          pieces_per_package: Math.max(1, Math.round(Number(r.pieces_per_package) || 1)),
          stock_pieces: Math.max(0, Math.floor(Number(r.stock_pieces) || 0)),
        });
      }
      return m;
    });

    return priced.map((r) => {
      const mx = meta.get(r.product_id);
      const stock = mx?.stock_pieces ?? 0;
      const factor = mx?.pieces_per_package ?? 1;
      return {
        product_id: r.product_id,
        name: r.product_name,
        brand_name: r.brand_name ?? null,
        unit_price: Number(r.price),
        min_qty: Number(r.min_qty) || 1,
        stock_pieces: stock,
        availability: this.stockBucket(stock, factor),
        pieces_per_package: factor,
      };
    });
  }

  /**
   * FIQ.2 (requisito 7) — Disponibilidad CUALITATIVA, sin revelar el total exacto.
   * El almacén de surtido es el mismo que usará el pedido (default activo, ver
   * LATERAL arriba), así que el bucket es consistente con lo que se puede reservar.
   *   agotado  = 0 piezas
   *   pocas    = quedan pocas (< 2 cajas si viene en caja, o < 12 piezas suelto)
   *   disponible = hay de sobra
   */
  private stockBucket(stock: number, factor: number): 'disponible' | 'pocas' | 'agotado' {
    if (stock <= 0) return 'agotado';
    const lowThreshold = factor > 1 ? factor * 2 : 12;
    return stock < lowThreshold ? 'pocas' : 'disponible';
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
