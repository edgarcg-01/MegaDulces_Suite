import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import type {
  CommerceConversationPort,
  ConversationCustomer,
  ConversationHistoryHit,
  ConversationOrderDto,
  ConversationOrderResult,
  ConversationProductHit,
  ConversationPromoHit,
  ConversationSuggestionHit,
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
/** Metadata de enriquecimiento por producto: empaque + existencia + tiers de precio. */
interface EnrichMeta {
  pieces_per_package: number;
  stock_pieces: number;
  tiers: Array<{ min_qty: number; price: number }>;
}

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

  async searchProducts(
    query: string,
    opts?: { limit?: number; customerId?: string | null },
  ): Promise<ConversationProductHit[]> {
    const q = (query || '').trim();
    if (!q) return [];
    // FIQ.3: cliente reconocido (FIQ.0) → precio de SU lista. Casual → lista de
    // CANAL (WHATSAPP_PRICE_LIST_CODE, p. ej. MAYOREO) si está configurada; si no,
    // default del tenant. El override solo aplica a casuales (customerId manda).
    const customerId = opts?.customerId ?? null;
    const priceListId = customerId ? null : await this.channelPriceListId();
    const { results } = await this.search.search({ query: q, limit: opts?.limit ?? 5, customerId, priceListId });
    const priced = results.filter((r) => r.price != null);
    if (priced.length === 0) return [];
    const meta = await this.enrichMeta(priced.map((r) => r.product_id));
    return priced.map((r) => this.toHit(r, meta));
  }

  /**
   * FIQ.4 (requisito 8) — Historial de compra del cliente (reconocido por teléfono
   * en FIQ.0) para "lo de siempre" / reorden. Reusa getMyHistory del motor (con
   * customerId explícito, sin JWT) + enriquece con precio/existencia/empaque como
   * la búsqueda. El bot ofrece re-agregar; el motor pone todos los números.
   */
  async customerHistory(
    customerId: string,
    opts?: { limit?: number; days?: number },
  ): Promise<ConversationHistoryHit[]> {
    if (!customerId) return [];
    const rows: any[] = await this.search.getMyHistory({
      customerId,
      warehouseId: null,
      days: opts?.days,
      limit: opts?.limit ?? 8,
    });
    const priced = rows.filter((r) => r.price != null);
    if (priced.length === 0) return [];
    const meta = await this.enrichMeta(priced.map((r) => r.product_id));
    return priced.map((r) => ({
      ...this.toHit(r, meta),
      times_ordered: Number(r.times_ordered) || 0,
      last_ordered_at: r.last_ordered_at ?? null,
    }));
  }

  /**
   * FIQ.4 (requisito 8+1) — Canasta IA de sugeridos (base/focus/exploration/
   * innovation) del cliente, para upsell/cross-sell. Reusa getMySuggested del
   * motor (con customerId explícito) + enriquece con precio/existencia/empaque.
   */
  async customerSuggested(customerId: string): Promise<ConversationSuggestionHit[]> {
    if (!customerId) return [];
    const rows: any[] = await this.search.getMySuggested({ customerId, warehouseId: null });
    const priced = rows.filter((r) => r.price != null);
    if (priced.length === 0) return [];
    const meta = await this.enrichMeta(priced.map((r) => r.product_id));
    return priced.map((r) => ({
      ...this.toHit(r, meta),
      reason: r.rec_reason ?? '',
      category: r.rec_category ?? null,
    }));
  }

  /**
   * FIQ.4 (requisito 1+6) — Productos con promoción activa aplicable al cliente
   * (o all_customers si casual). Reusa getWithPromo del motor + enriquece.
   */
  async activePromotions(opts?: { customerId?: string | null }): Promise<ConversationPromoHit[]> {
    const rows: any[] = await this.search.getWithPromo({
      customerId: opts?.customerId ?? null,
      warehouseId: null,
    });
    const priced = rows.filter((r) => r.price != null);
    if (priced.length === 0) return [];
    const meta = await this.enrichMeta(priced.map((r) => r.product_id));
    return priced.map((r) => ({
      ...this.toHit(r, meta),
      promo_name: r.promo_name ?? '',
      promo_type: r.promo_type ?? '',
    }));
  }

  /**
   * Enriquecimiento común (F.5): por cada product_id, existencia del almacén de
   * surtido (default activo, quantity − reserved) + empaque (factor_sale). Es el
   * MISMO almacén que usará el pedido → los buckets/topes son consistentes.
   */
  private async enrichMeta(ids: string[]): Promise<Map<string, EnrichMeta>> {
    if (!ids.length) return new Map();
    return this.tk.run(async (trx) => {
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
      const m = new Map<string, EnrichMeta>();
      for (const r of rows.rows) {
        m.set(r.product_id, {
          pieces_per_package: Math.max(1, Math.round(Number(r.pieces_per_package) || 1)),
          stock_pieces: Math.max(0, Math.floor(Number(r.stock_pieces) || 0)),
          tiers: [],
        });
      }
      // FIQ.3: tiers de precio por cantidad (misma pasada, un batch) → el bot muestra
      // el MISMO precio que el pedido cobra (resolvePriceForQty), pieza y caja.
      const priceRows = await trx('commercial.product_prices')
        .whereIn('product_id', ids)
        .whereNull('deleted_at')
        .select('product_id', 'price', 'min_qty');
      for (const pr of priceRows) {
        const e = m.get(pr.product_id);
        if (e) e.tiers.push({ min_qty: Math.max(1, Number(pr.min_qty) || 1), price: Number(pr.price) });
      }
      return m;
    });
  }

  /** Mejor precio (menor) con min_qty <= qty. null si qty < mínimo. Espejo de resolvePriceForQty. */
  private bestTierPrice(tiers: Array<{ min_qty: number; price: number }>, qty: number): number | null {
    const applicable = tiers.filter((t) => t.min_qty <= qty);
    if (!applicable.length) return null;
    return applicable.reduce((a, b) => (b.price < a.price ? b : a)).price;
  }

  /**
   * FIQ.3: lista de precio del canal WhatsApp para CASUALES (sin cartera). Si
   * `WHATSAPP_PRICE_LIST_CODE` no está seteada, devuelve null → el motor cae a la
   * lista default del tenant. Permite cotizar MAYOREO al público del bot sin tocar
   * el default global (decisión de negocio configurable, no hardcodeada).
   */
  private async channelPriceListId(): Promise<string | null> {
    const code = process.env.WHATSAPP_PRICE_LIST_CODE;
    if (!code) return null;
    return this.tk.run(async (trx) => {
      const r = await trx('commercial.price_lists').where({ code }).whereNull('deleted_at').first('id');
      if (!r) {
        this.logger.warn(`WHATSAPP_PRICE_LIST_CODE=${code} no existe — uso lista default del tenant.`);
        return null;
      }
      return r.id as string;
    });
  }

  /** Mapea una fila (search/historial) a un hit: precio POR CANTIDAD (tier) + bucket de existencia. */
  private toHit(r: any, meta: Map<string, EnrichMeta>): ConversationProductHit {
    const mx = meta.get(r.product_id);
    const stock = mx?.stock_pieces ?? 0;
    const factor = mx?.pieces_per_package ?? 1;
    const tiers = mx?.tiers ?? [];
    // FIQ.3: precio pieza = tier de entrada (mínimo de compra); precio caja = tier a la
    // caja (factor). Mismo cálculo que resolvePriceForQty → el bot cotiza = el pedido cobra.
    const minPurchase = tiers.length ? Math.min(...tiers.map((t) => t.min_qty)) : 1;
    const piecePrice = this.bestTierPrice(tiers, minPurchase) ?? Number(r.price);
    const boxUnit = this.bestTierPrice(tiers, factor) ?? piecePrice;
    return {
      product_id: r.product_id,
      name: r.product_name,
      brand_name: r.brand_name ?? null,
      unit_price: piecePrice,
      // FIQ.3: precio por caja al TIER de la caja (mayoreo real), no pieza×factor.
      price_per_package: Math.round(boxUnit * factor * 100) / 100,
      min_qty: minPurchase,
      stock_pieces: stock,
      availability: this.stockBucket(stock, factor),
      pieces_per_package: factor,
    };
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
