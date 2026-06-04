import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { EmbeddingsService } from '@megadulces/platform-core';
import { RecommendationsService } from '../commercial-recommendations/recommendations.service';
import {
  RecommendationCategory,
  RecommendationItem,
} from '../commercial-recommendations/recommendations.types';

interface SearchInput {
  query: string;
  limit: number;
  /**
   * Si viene null/undefined, el service intenta resolver el customer del JWT
   * via `identity.users.customer_id`. Si tampoco hay (admin/superadmin sin
   * customer linkeado), cae al price_list default del tenant.
   */
  customerId?: string | null;
}

interface SearchResult {
  product_id: string;
  product_name: string;
  brand_id: string | null;
  brand_name: string | null;
  price: number;
  tax_rate: number;
  min_qty: number;
  stock_available: number | null;
  score: number;
}

@Injectable()
export class CommercialCatalogSearchService {
  private readonly logger = new Logger(CommercialCatalogSearchService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly embeddings: EmbeddingsService,
    private readonly recommendations: RecommendationsService,
  ) {}

  async search(input: SearchInput): Promise<{ results: SearchResult[]; mode: 'semantic' | 'fallback_like' }> {
    const customerId = input.customerId ?? (await this.resolveCustomerIdFromCtx());
    const priceListId = await this.resolvePriceListId(customerId);
    if (!priceListId) return { results: [], mode: 'fallback_like' };

    // Si falta VOYAGE_API_KEY, cae a búsqueda LIKE tradicional para no romper UX.
    if (!process.env.VOYAGE_API_KEY) {
      this.logger.warn('VOYAGE_API_KEY ausente — search cae a LIKE');
      const rows = await this.likeSearch(priceListId, input.query, input.limit);
      return { results: rows, mode: 'fallback_like' };
    }

    let vec: number[];
    try {
      vec = await this.embeddings.embedSingle(input.query, 'query');
    } catch (e: any) {
      this.logger.warn(`Voyage embed failed (${e.message}) — fallback LIKE`);
      const rows = await this.likeSearch(priceListId, input.query, input.limit);
      return { results: rows, mode: 'fallback_like' };
    }

    const vecLiteral = `[${vec.join(',')}]`;
    return this.tk.run(async (trx) => {
      const res = await trx.raw(
        `
        SELECT
          p.id              AS product_id,
          p.nombre          AS product_name,
          p.brand_id        AS brand_id,
          COALESCE(b.display_name, b.nombre) AS brand_name,
          pp.price          AS price,
          pp.tax_rate       AS tax_rate,
          pp.min_qty        AS min_qty,
          NULL::int         AS stock_available,
          1 - (p.embedding <=> ?::vector) AS score
        FROM commercial.product_prices pp
        JOIN catalog.products p
          ON p.id = pp.product_id
         AND p.tenant_id = pp.tenant_id
        LEFT JOIN catalog.brands b
          ON b.id = p.brand_id
         AND b.tenant_id = p.tenant_id
        WHERE pp.price_list_id = ?
          AND pp.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND p.embedding IS NOT NULL
        ORDER BY p.embedding <=> ?::vector
        LIMIT ?
        `,
        [vecLiteral, priceListId, vecLiteral, input.limit],
      );
      const rows: SearchResult[] = res.rows.map((r: any) => ({
        product_id: r.product_id,
        product_name: r.product_name,
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        price: Number(r.price),
        tax_rate: Number(r.tax_rate),
        min_qty: Number(r.min_qty),
        stock_available: r.stock_available == null ? null : Number(r.stock_available),
        score: Number(r.score) || 0,
      }));
      return { results: rows, mode: 'semantic' as const };
    });
  }

  /**
   * Catálogo completo: TODOS los productos activos del tenant. Para el precio
   * aplica la **misma cadena de fallback** que `PricingService.resolvePriceForCustomer`
   * (la que usa `OrdersService.addLine`) — si no, el portal mostraba "Sin precio"
   * y el `Agregar` igualmente funcionaba porque addLine resolvía con fallback.
   *
   * Orden de resolución por producto:
   *   1. Precio configurado en `customer.default_price_list_id`.
   *   2. Fallback: precio del price_list default del tenant.
   *   3. Si ninguno → realmente sin precio (badge "Sin precio").
   *
   * Anchor sigue siendo `catalog.products` para que aparezcan TODOS los SKUs
   * activos, no solo los que tienen precio explícito.
   */
  async listAllProducts(input: {
    customerId?: string | null;
    warehouseId: string | null;
    /** Si true (default), filtra productos sin precio resolvible. */
    onlyWithPrice?: boolean;
    /**
     * Si viene, restringe a estos product_ids (subset). Útil para hidratar
     * un set predefinido — p.ej. el historial del customer en `getMyHistory`
     * — sin re-implementar la lógica de fallback de pricing/stock.
     */
    productIds?: string[];
    /** Search ILIKE en product_name OR brand_name. */
    q?: string;
    /** Filtro exacto por brand_id. */
    brandId?: string;
    /** Filtros por precio resuelto (post-coalesce). */
    priceMin?: number;
    priceMax?: number;
    /** Si true, solo productos con stock_available > 0 (requiere warehouseId). */
    hasStock?: boolean;
    /**
     * Paginación opcional. Si CUALQUIERA de los dos viene, el método devuelve
     * `{ data, pagination }` en vez de `PriceRow[]` plano. Backward-compat:
     * sin estos params, retorna array (no rompe portal-catalog actual).
     */
    page?: number;
    pageSize?: number;
  }): Promise<any> {
    const customerId = input.customerId ?? (await this.resolveCustomerIdFromCtx());
    const customerPriceListId = await this.resolveCustomerPriceListId(customerId);
    const defaultPriceListId = await this.resolveDefaultPriceListId();
    const onlyWithPrice = input.onlyWithPrice !== false;

    return this.tk.run(async (trx) => {
      let q = trx('catalog.products as p')
        .leftJoin('catalog.brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        // Imagen desde inventory.products_active (catalog.products no debe tener foto).
        // JOIN por SKU con fallback a `articulo` para data Railway con sku NULL.
        .leftJoin('inventory.products_active as ipa', function () {
          this.on(trx.raw('ipa.sku = COALESCE(p.sku, p.articulo)'));
        });

      // LEFT JOIN precio del price_list del customer (puede no haberlo configurado).
      if (customerPriceListId) {
        q = q.leftJoin('commercial.product_prices as pp_cust', function () {
          this.on('pp_cust.product_id', '=', 'p.id')
            .andOn('pp_cust.tenant_id', '=', 'p.tenant_id')
            .andOnVal('pp_cust.price_list_id', customerPriceListId);
          this.andOnNull('pp_cust.deleted_at');
        });
      }
      // LEFT JOIN precio del default tenant — fallback si el customer no lo trae.
      // Si el customer apunta al MISMO price_list que el default, evitamos el
      // doble join (sería siempre la misma fila).
      const needsDefaultJoin =
        defaultPriceListId && defaultPriceListId !== customerPriceListId;
      if (needsDefaultJoin) {
        q = q.leftJoin('commercial.product_prices as pp_def', function () {
          this.on('pp_def.product_id', '=', 'p.id')
            .andOn('pp_def.tenant_id', '=', 'p.tenant_id')
            .andOnVal('pp_def.price_list_id', defaultPriceListId!);
          this.andOnNull('pp_def.deleted_at');
        });
      }

      // LEFT JOIN stock del warehouse (si se pidió).
      if (input.warehouseId) {
        q = q.leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'p.id')
            .andOn('s.tenant_id', '=', 'p.tenant_id')
            .andOnVal('s.warehouse_id', input.warehouseId!);
        });
      }

      const selects: any[] = [
        'p.id as product_id',
        'p.nombre as product_name',
        'p.brand_id as brand_id',
        trx.raw('COALESCE(b.display_name, b.nombre) as brand_name'),
        'ipa.image_url as image_url',
      ];

      // COALESCE: si el customer tiene precio, gana; sino, default del tenant.
      if (customerPriceListId && needsDefaultJoin) {
        selects.push(
          trx.raw('COALESCE(pp_cust.id, pp_def.id) as id'),
          trx.raw('COALESCE(pp_cust.price, pp_def.price) as price'),
          trx.raw('COALESCE(pp_cust.tax_rate, pp_def.tax_rate) as tax_rate'),
          trx.raw('COALESCE(pp_cust.min_qty, pp_def.min_qty, 1) as min_qty'),
          trx.raw(
            `CASE
               WHEN pp_cust.id IS NOT NULL THEN 'customer'
               WHEN pp_def.id IS NOT NULL THEN 'tenant_default'
               ELSE NULL
             END as price_source`,
          ),
        );
      } else if (customerPriceListId) {
        // Customer apunta al default → un único join.
        selects.push(
          'pp_cust.id as id',
          'pp_cust.price as price',
          'pp_cust.tax_rate as tax_rate',
          trx.raw('COALESCE(pp_cust.min_qty, 1) as min_qty'),
          trx.raw(`CASE WHEN pp_cust.id IS NOT NULL THEN 'customer' ELSE NULL END as price_source`),
        );
      } else if (defaultPriceListId) {
        // Sin price_list del customer → usar SOLO default del tenant.
        selects.push(
          'pp_def.id as id',
          'pp_def.price as price',
          'pp_def.tax_rate as tax_rate',
          trx.raw('COALESCE(pp_def.min_qty, 1) as min_qty'),
          trx.raw(`CASE WHEN pp_def.id IS NOT NULL THEN 'tenant_default' ELSE NULL END as price_source`),
        );
      } else {
        selects.push(
          trx.raw('p.id as id'),
          trx.raw('NULL::numeric as price'),
          trx.raw('NULL::numeric as tax_rate'),
          trx.raw('1 as min_qty'),
          trx.raw(`NULL as price_source`),
        );
      }

      if (input.warehouseId) {
        selects.push(
          trx.raw(
            'CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0) END AS stock_available',
          ),
        );
      } else {
        selects.push(trx.raw('NULL::int AS stock_available'));
      }

      // Filtro "solo comprables": exige que exista precio resolvible. Sin esto
      // el portal mostraba 1200+ SKUs del RAG sin precio (ruido absoluto para
      // el cliente, que no puede comprarlos).
      if (onlyWithPrice) {
        q = q.andWhere((b: any) => {
          if (customerPriceListId) b.orWhereNotNull('pp_cust.id');
          if (needsDefaultJoin) b.orWhereNotNull('pp_def.id');
          if (!customerPriceListId && defaultPriceListId) b.orWhereNotNull('pp_def.id');
          if (!customerPriceListId && !defaultPriceListId) b.orWhereRaw('1 = 0');
        });
      }

      q = q.where('p.activo', true).whereNull('p.deleted_at');
      // Filtro `is_commercial`: oculta brands operativas/admin/promo del
      // catálogo cliente. Brands sin record (brand_id NULL) se incluyen.
      q = q.andWhere((b: any) => {
        b.whereNull('b.id').orWhere('b.is_commercial', true);
      });
      if (input.productIds && input.productIds.length > 0) {
        q = q.whereIn('p.id', input.productIds);
      }

      // Search ILIKE en product_name OR brand_name (display_name preferido).
      // Escapamos % y _ del input para evitar wildcards del usuario que
      // vuelvan caro el query plan.
      if (input.q && input.q.trim()) {
        const term = `%${input.q.trim().replace(/[%_\\]/g, '\\$&')}%`;
        q = q.andWhere((b: any) => {
          b.whereILike('p.nombre', term)
            .orWhereILike('b.nombre', term)
            .orWhereILike('b.display_name', term);
        });
      }

      if (input.brandId) {
        q = q.where('p.brand_id', input.brandId);
      }

      // Precio resuelto post-coalesce — replicamos la expresión del SELECT
      // porque WHERE no puede referenciar aliases.
      const priceExpr =
        customerPriceListId && needsDefaultJoin
          ? 'COALESCE(pp_cust.price, pp_def.price)'
          : customerPriceListId
            ? 'pp_cust.price'
            : defaultPriceListId
              ? 'pp_def.price'
              : 'NULL::numeric';
      if (input.priceMin != null) {
        q = q.andWhereRaw(`${priceExpr} >= ?`, [Number(input.priceMin)]);
      }
      if (input.priceMax != null) {
        q = q.andWhereRaw(`${priceExpr} <= ?`, [Number(input.priceMax)]);
      }

      if (input.hasStock && input.warehouseId) {
        // s.id IS NOT NULL filtra rows que tienen registro en stock; el cálculo
        // disponible = quantity - reserved > 0 garantiza que el cliente puede
        // pedir al menos 1.
        q = q.andWhereRaw(
          'COALESCE(s.quantity, 0) - COALESCE(s.reserved_quantity, 0) > 0',
        );
      }

      const paginated = input.page != null || input.pageSize != null;

      if (paginated) {
        const page = Math.max(1, Number(input.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(input.pageSize) || 60));
        // Clone ANTES de agregar select/orderBy/limit/offset — count debe usar
        // exactamente los mismos joins+filtros pero sin orden ni paginación.
        const countQ = q.clone();
        const totalRow: any = await countQ
          .clearSelect()
          .clearOrder()
          .count<{ cnt: string }>('* as cnt')
          .first();
        const total = Number(totalRow?.cnt || 0);

        const rows = await q
          .select(...selects)
          .orderBy('b.nombre', 'asc')
          .orderBy('p.nombre', 'asc')
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        return {
          data: rows.map((r: any) => this.toRow(r)),
          pagination: {
            page,
            pageSize,
            total,
            pageCount: Math.ceil(total / pageSize),
          },
        };
      }

      const rows = await q
        .select(...selects)
        .orderBy('b.nombre', 'asc')
        .orderBy('p.nombre', 'asc');

      return rows.map((r: any) => this.toRow(r));
    });
  }

  private toRow(r: any) {
    return {
      id: r.id,
      product_id: r.product_id,
      product_name: r.product_name,
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      image_url: r.image_url || null,
      price: r.price == null ? null : Number(r.price),
      tax_rate: r.tax_rate == null ? null : Number(r.tax_rate),
      min_qty: Number(r.min_qty || 1),
      stock_available: r.stock_available == null ? null : Number(r.stock_available),
      price_source: r.price_source || null,
    };
  }

  /**
   * Productos que ESTE customer ya compró en los últimos N días, ordenados
   * por frecuencia (#órdenes en las que apareció) y recencia. Devuelve el
   * mismo shape que `listAllProducts` + campos extra `times_ordered` y
   * `last_ordered_at` para drive del UI ("compraste X veces, última vez …").
   *
   * Solo cuenta órdenes en estados que confirmaron intención de compra:
   * `pending_approval`, `confirmed`, `fulfilled`. Drafts y cancelled no aportan
   * señal. Si el customer no tiene historial → array vacío.
   */
  async getMyHistory(input: {
    warehouseId: string | null;
    days?: number;
    limit?: number;
  }) {
    const customerId = await this.resolveCustomerIdFromCtx();
    if (!customerId) return [];
    const days = Math.max(1, Math.min(365, input.days ?? 90));
    const limit = Math.max(1, Math.min(200, input.limit ?? 60));

    const meta = await this.tk.run(async (trx) => {
      const rows = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .where('o.customer_id', customerId)
        .whereIn('o.status', ['pending_approval', 'confirmed', 'fulfilled'])
        .where('o.created_at', '>', trx.raw(`NOW() - INTERVAL '${days} days'`))
        .groupBy('ol.product_id')
        .orderByRaw('COUNT(DISTINCT o.id) DESC, MAX(o.created_at) DESC')
        .limit(limit)
        .select(
          'ol.product_id',
          trx.raw('COUNT(DISTINCT o.id)::int AS times_ordered'),
          trx.raw('MAX(o.created_at) AS last_ordered_at'),
          trx.raw('SUM(ol.quantity)::numeric AS total_quantity'),
        );
      return rows as Array<{
        product_id: string;
        times_ordered: number;
        last_ordered_at: string;
        total_quantity: string;
      }>;
    });

    if (meta.length === 0) return [];

    const productIds = meta.map((m) => m.product_id);
    // Mostramos histórico incluso si el producto perdió precio configurado
    // — el cliente reconoce el SKU por su compra anterior; con badge "sin precio"
    // ya queda claro que hoy no es comprable.
    const rows = await this.listAllProducts({
      customerId,
      warehouseId: input.warehouseId,
      onlyWithPrice: false,
      productIds,
    });

    const metaById = new Map(meta.map((m) => [m.product_id, m]));
    const orderIndex = new Map(productIds.map((id, i) => [id, i]));
    return rows
      .map((r: any) => {
        const m = metaById.get(r.product_id);
        return {
          ...r,
          times_ordered: m?.times_ordered ?? 0,
          last_ordered_at: m?.last_ordered_at ?? null,
          total_quantity: m ? Number(m.total_quantity) : 0,
        };
      })
      .sort(
        (a: any, b: any) =>
          (orderIndex.get(a.product_id) ?? 999) -
          (orderIndex.get(b.product_id) ?? 999),
      );
  }

  /**
   * Canasta IA del customer (D.4) hidratada con precio/stock/marca del catálogo.
   * Mismo shape que `getMyHistory` para que el frontend renderice ambos chips
   * en el mismo grid. Orden: por score desc (mayor relevancia primero).
   *
   * El service downstream (`RecommendationsService.getForMyCustomer`) ya tiene
   * cache 24h interno + recompute on demand, así que llamarlo en cada request
   * es barato.
   */
  async getMySuggested(input: { warehouseId: string | null }) {
    const customerId = await this.resolveCustomerIdFromCtx();
    if (!customerId) return [];

    let basket;
    try {
      basket = await this.recommendations.getForMyCustomer();
    } catch {
      // Customer sin pedidos previos → la heurística puede fallar; degradación
      // suave: devolvemos [] y el chip simplemente no aparece.
      return [];
    }

    if (!basket?.items?.length) return [];

    const productIds = basket.items.map((i) => i.product_id);
    const rows = await this.listAllProducts({
      customerId,
      warehouseId: input.warehouseId,
      onlyWithPrice: false,
      productIds,
    });

    const metaById = new Map<string, RecommendationItem>(
      basket.items.map((i) => [i.product_id, i] as const),
    );
    return rows
      .map((r: any) => {
        const m = metaById.get(r.product_id);
        return {
          ...r,
          rec_category: (m?.category ?? null) as RecommendationCategory | null,
          rec_score: m?.score ?? 0,
          rec_reason: m?.reason ?? '',
        };
      })
      .sort((a: any, b: any) => (b.rec_score ?? 0) - (a.rec_score ?? 0));
  }

  /**
   * Facets agregados del catálogo del customer del JWT — para drive de
   * sidebar/bottom-sheet con counts reales (no "Marca (?)").
   *
   * Devuelve:
   *   - brands: top-N por # productos (default 30 — el resto va en bucket "más marcas")
   *   - price_buckets: 4 buckets fijos sobre el catálogo del customer
   *   - stock: count de productos con stock disponible vs sin (si warehouseId)
   *   - total: count global del catálogo aplicable
   *
   * Reusa el mismo set de filtros que `listAllProducts` (price list fallback,
   * onlyWithPrice) para que el universo de facets matchee 1:1 con el grid.
   */
  async getFacets(input: {
    warehouseId: string | null;
    brandsLimit?: number;
  }): Promise<{
    total: number;
    brands: Array<{ brand_id: string | null; brand_name: string | null; count: number }>;
    price_buckets: Array<{ label: string; min: number; max: number | null; count: number }>;
    stock: { with_stock: number; without_stock: number } | null;
  }> {
    const customerId = await this.resolveCustomerIdFromCtx();
    const customerPriceListId = await this.resolveCustomerPriceListId(customerId);
    const defaultPriceListId = await this.resolveDefaultPriceListId();
    const needsDefaultJoin =
      defaultPriceListId && defaultPriceListId !== customerPriceListId;
    const priceExpr =
      customerPriceListId && needsDefaultJoin
        ? 'COALESCE(pp_cust.price, pp_def.price)'
        : customerPriceListId
          ? 'pp_cust.price'
          : defaultPriceListId
            ? 'pp_def.price'
            : 'NULL::numeric';
    const brandsLimit = Math.max(5, Math.min(100, input.brandsLimit ?? 30));

    return this.tk.run(async (trx) => {
      // Base query: misma estructura de listAllProducts pero sin select/order
      // — solo construimos el universo filtrado para que count/group corra encima.
      const baseFrom = trx('catalog.products as p').leftJoin(
        'catalog.brands as b',
        function () {
          this.on('b.id', '=', 'p.brand_id').andOn(
            'b.tenant_id',
            '=',
            'p.tenant_id',
          );
        },
      );
      if (customerPriceListId) {
        baseFrom.leftJoin('commercial.product_prices as pp_cust', function () {
          this.on('pp_cust.product_id', '=', 'p.id')
            .andOn('pp_cust.tenant_id', '=', 'p.tenant_id')
            .andOnVal('pp_cust.price_list_id', customerPriceListId);
          this.andOnNull('pp_cust.deleted_at');
        });
      }
      if (needsDefaultJoin) {
        baseFrom.leftJoin('commercial.product_prices as pp_def', function () {
          this.on('pp_def.product_id', '=', 'p.id')
            .andOn('pp_def.tenant_id', '=', 'p.tenant_id')
            .andOnVal('pp_def.price_list_id', defaultPriceListId!);
          this.andOnNull('pp_def.deleted_at');
        });
      }
      if (input.warehouseId) {
        baseFrom.leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'p.id')
            .andOn('s.tenant_id', '=', 'p.tenant_id')
            .andOnVal('s.warehouse_id', input.warehouseId!);
        });
      }
      baseFrom.where('p.activo', true).whereNull('p.deleted_at');
      // Mismo filtro que listAllProducts: solo brands comerciales (o productos
      // sin brand). Sin esto los facets contaban brands operativas/admin.
      baseFrom.andWhere((b: any) => {
        b.whereNull('b.id').orWhere('b.is_commercial', true);
      });
      // Universo del facet = productos con precio resolvible (igual que el grid
      // con onlyWithPrice por defecto).
      baseFrom.andWhere((b: any) => {
        if (customerPriceListId) b.orWhereNotNull('pp_cust.id');
        if (needsDefaultJoin) b.orWhereNotNull('pp_def.id');
        if (!customerPriceListId && defaultPriceListId)
          b.orWhereNotNull('pp_def.id');
        if (!customerPriceListId && !defaultPriceListId) b.orWhereRaw('1 = 0');
      });

      const totalRow: any = await baseFrom.clone().count('* as cnt').first();
      const total = Number(totalRow?.cnt || 0);

      const brandRows: any[] = await baseFrom
        .clone()
        .select('p.brand_id', trx.raw('COALESCE(b.display_name, b.nombre) as brand_name'))
        .count('* as count')
        .groupBy('p.brand_id', 'b.display_name', 'b.nombre')
        .orderBy('count', 'desc')
        .limit(brandsLimit);

      // Buckets fijos calibrados según la mediana real ($43 MXN) — cubren los
      // 4 cuartiles aproximados. Futuro: por-tenant configurable.
      const bucketDefs: Array<{ label: string; min: number; max: number | null }> = [
        { label: 'Hasta $25', min: 0, max: 25 },
        { label: '$25 – $50', min: 25, max: 50 },
        { label: '$50 – $100', min: 50, max: 100 },
        { label: 'Más de $100', min: 100, max: null },
      ];
      // Secuencial porque la trx del TenantContextInterceptor usa una sola
      // conexión pg y queries concurrentes disparan DeprecationWarning (pg@9).
      const price_buckets: Array<{ label: string; min: number; max: number | null; count: number }> = [];
      for (const def of bucketDefs) {
        const q = baseFrom.clone().whereRaw(`${priceExpr} >= ?`, [def.min]);
        if (def.max != null) q.andWhereRaw(`${priceExpr} < ?`, [def.max]);
        const r: any = await q.count('* as cnt').first();
        price_buckets.push({ ...def, count: Number(r?.cnt || 0) });
      }

      let stock: { with_stock: number; without_stock: number } | null = null;
      if (input.warehouseId) {
        const withQ: any = await baseFrom
          .clone()
          .whereRaw(
            'COALESCE(s.quantity, 0) - COALESCE(s.reserved_quantity, 0) > 0',
          )
          .count('* as cnt')
          .first();
        const wq = Number(withQ?.cnt || 0);
        stock = { with_stock: wq, without_stock: total - wq };
      }

      return {
        total,
        brands: brandRows.map((r: any) => ({
          brand_id: r.brand_id,
          brand_name: r.brand_name,
          count: Number(r.count),
        })),
        price_buckets,
        stock,
      };
    });
  }

  /**
   * Productos con al menos una promoción activa aplicable al customer del JWT.
   * Hidrata con precio/stock para que el frontend renderice como un grid normal.
   * Cada row trae metadata de UNA promo (la primera encontrada — futuro: la
   * de mayor `priority`).
   *
   * Skip de `percent_off_basket`: aplica al pedido completo, no a productos
   * específicos, así que listarlo en este chip sería ruido.
   *
   * Extracción de product_ids del JSONB:
   *   - percent_off_product / nxm / volume_discount → `rules.product_id`
   *   - cross_sell_discount → `rules.target_product_id` + `rules.trigger_product_id`
   *   - bundle_fixed_price → `rules.items[].product_id`
   */
  async getWithPromo(input: { warehouseId: string | null }) {
    const customerId = await this.resolveCustomerIdFromCtx();

    const promos = await this.tk.run(async (trx) =>
      trx('commercial.promotions')
        .where('active', true)
        .whereNull('deleted_at')
        .whereNot('promotion_type', 'percent_off_basket')
        .andWhere((q) =>
          q.whereNull('starts_at').orWhere('starts_at', '<=', trx.fn.now()),
        )
        .andWhere((q) =>
          q.whereNull('ends_at').orWhere('ends_at', '>=', trx.fn.now()),
        )
        .select(
          'id',
          'code',
          'name',
          'promotion_type',
          'rules',
          'priority',
          'applies_to',
          'applies_to_customer_ids',
        ),
    );

    // Filtro de `applies_to`: only `all_customers` para todos, o
    // `specific_customers` cuando el customer está en la lista. Conservador
    // — si el shape es inesperado, skip la promo.
    const applicablePromos = promos.filter((p: any) => {
      if (p.applies_to === 'all_customers' || !p.applies_to) return true;
      if (p.applies_to === 'specific_customers' && customerId) {
        const list = Array.isArray(p.applies_to_customer_ids)
          ? p.applies_to_customer_ids
          : [];
        return list.includes(customerId);
      }
      return false;
    });

    if (applicablePromos.length === 0) return [];

    // Map product_id → primera promo (ordenado por priority desc así la
    // "mejor" gana cuando un producto está en varias).
    applicablePromos.sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0));
    const productPromoMap = new Map<
      string,
      { promo_code: string; promo_name: string; promo_type: string }
    >();
    for (const p of applicablePromos) {
      const rules = p.rules || {};
      const ids: string[] = [];
      if (typeof rules.product_id === 'string') ids.push(rules.product_id);
      if (typeof rules.target_product_id === 'string') ids.push(rules.target_product_id);
      if (typeof rules.trigger_product_id === 'string') ids.push(rules.trigger_product_id);
      if (Array.isArray(rules.items)) {
        for (const it of rules.items) {
          if (it && typeof it.product_id === 'string') ids.push(it.product_id);
        }
      }
      for (const pid of ids) {
        if (!productPromoMap.has(pid)) {
          productPromoMap.set(pid, {
            promo_code: p.code,
            promo_name: p.name,
            promo_type: p.promotion_type,
          });
        }
      }
    }

    if (productPromoMap.size === 0) return [];

    const productIds = Array.from(productPromoMap.keys());
    const rows = await this.listAllProducts({
      customerId,
      warehouseId: input.warehouseId,
      onlyWithPrice: false,
      productIds,
    });

    return rows.map((r: any) => ({
      ...r,
      ...productPromoMap.get(r.product_id)!,
    }));
  }

  /**
   * Resuelve el customer_id linkeado al user del JWT (tenantCtx.userId →
   * identity.users.customer_id). Mismo patrón que orders.service. Devuelve null
   * para users sin link (admin/superadmin) — el caller decide fallback.
   */
  private async resolveCustomerIdFromCtx(): Promise<string | null> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return null;
    return this.tk.run(async (trx) => {
      const row = await trx('identity.users').where({ id: userId }).select('customer_id').first();
      return row?.customer_id || null;
    });
  }

  /**
   * Compat: la búsqueda semántica todavía usa una sola price_list (un solo
   * resolver). Resuelve igual que antes (customer override → tenant default).
   */
  private async resolvePriceListId(customerId: string | null): Promise<string | null> {
    const c = await this.resolveCustomerPriceListId(customerId);
    return c || (await this.resolveDefaultPriceListId());
  }

  /** Solo el price_list del customer (si tiene). Sin fallback. */
  private async resolveCustomerPriceListId(customerId: string | null): Promise<string | null> {
    if (!customerId) return null;
    return this.tk.run(async (trx) => {
      const c = await trx('commercial.customers')
        .where({ id: customerId })
        .first('default_price_list_id');
      return (c?.default_price_list_id as string) || null;
    });
  }

  /** Price_list default del tenant (fallback). */
  private async resolveDefaultPriceListId(): Promise<string | null> {
    return this.tk.run(async (trx) => {
      const def = await trx('commercial.price_lists')
        .where({ is_default: true })
        .whereNull('deleted_at')
        .first('id');
      return def?.id || null;
    });
  }

  private async likeSearch(
    priceListId: string,
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const term = `%${query.replace(/[%_]/g, '\\$&')}%`;
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.product_prices as pp')
        .leftJoin('catalog.products as p', function () {
          this.on('p.id', '=', 'pp.product_id').andOn('p.tenant_id', '=', 'pp.tenant_id');
        })
        .leftJoin('catalog.brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        .where('pp.price_list_id', priceListId)
        .whereNull('pp.deleted_at')
        .whereNull('p.deleted_at')
        .andWhere((q: any) => {
          q.whereILike('p.nombre', term)
            .orWhereILike('b.nombre', term)
            .orWhereILike('b.display_name', term);
        })
        .orderBy('p.nombre', 'asc')
        .limit(limit)
        .select(
          'p.id as product_id',
          'p.nombre as product_name',
          'p.brand_id as brand_id',
          trx.raw('COALESCE(b.display_name, b.nombre) as brand_name'),
          'pp.price',
          'pp.tax_rate',
          'pp.min_qty',
        );
      return rows.map((r: any) => ({
        product_id: r.product_id,
        product_name: r.product_name,
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        price: Number(r.price),
        tax_rate: Number(r.tax_rate),
        min_qty: Number(r.min_qty),
        stock_available: null,
        score: 0,
      }));
    });
  }
}
