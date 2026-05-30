import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';
import { EmbeddingsService } from '../../shared/ai/embeddings.service';

interface SearchInput {
  query: string;
  limit: number;
  customerId: string | null;
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
    private readonly embeddings: EmbeddingsService,
  ) {}

  async search(input: SearchInput): Promise<{ results: SearchResult[]; mode: 'semantic' | 'fallback_like' }> {
    const priceListId = await this.resolvePriceListId(input.customerId);
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
          b.nombre          AS brand_name,
          pp.price          AS price,
          pp.tax_rate       AS tax_rate,
          pp.min_qty        AS min_qty,
          NULL::int         AS stock_available,
          1 - (p.embedding <=> ?::vector) AS score
        FROM commercial.product_prices pp
        JOIN public.products p
          ON p.id = pp.product_id
         AND p.tenant_id = pp.tenant_id
        LEFT JOIN public.brands b
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
   * Anchor sigue siendo `public.products` para que aparezcan TODOS los SKUs
   * activos, no solo los que tienen precio explícito.
   */
  async listAllProducts(input: {
    customerId: string | null;
    warehouseId: string | null;
    /** Si true (default), filtra productos sin precio resolvible. */
    onlyWithPrice?: boolean;
  }) {
    const customerPriceListId = await this.resolveCustomerPriceListId(input.customerId);
    const defaultPriceListId = await this.resolveDefaultPriceListId();
    const onlyWithPrice = input.onlyWithPrice !== false;

    return this.tk.run(async (trx) => {
      let q = trx('public.products as p')
        .leftJoin('public.brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
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
        'b.nombre as brand_name',
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

      const rows = await q
        .where('p.activo', true)
        .whereNull('p.deleted_at')
        .select(...selects)
        .orderBy('b.nombre', 'asc')
        .orderBy('p.nombre', 'asc');

      return rows.map((r: any) => ({
        id: r.id,
        product_id: r.product_id,
        product_name: r.product_name,
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        price: r.price == null ? null : Number(r.price),
        tax_rate: r.tax_rate == null ? null : Number(r.tax_rate),
        min_qty: Number(r.min_qty || 1),
        stock_available: r.stock_available == null ? null : Number(r.stock_available),
        price_source: r.price_source || null,
      }));
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
        .leftJoin('public.products as p', function () {
          this.on('p.id', '=', 'pp.product_id').andOn('p.tenant_id', '=', 'pp.tenant_id');
        })
        .leftJoin('public.brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        .where('pp.price_list_id', priceListId)
        .whereNull('pp.deleted_at')
        .whereNull('p.deleted_at')
        .andWhere((q: any) => {
          q.whereILike('p.nombre', term).orWhereILike('b.nombre', term);
        })
        .orderBy('p.nombre', 'asc')
        .limit(limit)
        .select(
          'p.id as product_id',
          'p.nombre as product_name',
          'p.brand_id as brand_id',
          'b.nombre as brand_name',
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
