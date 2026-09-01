import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

// ─────────── DTOs ───────────

export interface CreatePriceListDto {
  code: string;
  name: string;
  currency?: string;
  valid_from?: string;
  valid_to?: string;
  is_default?: boolean;
  active?: boolean;
  notes?: string;
}
export type UpdatePriceListDto = Partial<CreatePriceListDto>;

export interface UpsertProductPriceDto {
  product_id: string;
  price: number;
  tax_rate?: number;
  min_qty?: number;
}

export interface BulkUpsertProductPricesDto {
  price_list_id: string;
  items: UpsertProductPriceDto[];
}

/**
 * Campos del upsert que son OPCIONALES de verdad: ausente = "no lo toques",
 * no "ponelo en su default". `min_qty` manda el precio por cantidad
 * (`resolvePriceForQty`) y `tax_rate` el IVA de la línea; pisarlos desde una
 * pantalla que sólo edita el precio es pérdida silenciosa de datos.
 */
export const OPTIONAL_PRICE_FIELDS = ['tax_rate', 'min_qty'] as const;
export type OptionalPriceField = (typeof OPTIONAL_PRICE_FIELDS)[number];

// ─────────── salud del precio ───────────

/**
 * Diagnóstico de un precio. Los cuatro son **disjuntos** a propósito: un precio
 * centinela también está bajo costo, pero contarlo dos veces haría que los chips
 * de la UI sumaran más que el total y el usuario dejaría de creerles.
 *
 *  - `sentinel`   precio piso de promo ($0.01/$0.05 que mete el sync de Kepler).
 *                 No es un precio: es una marca. Se evalúa primero.
 *  - `below_cost` pérdida real: se vende por menos de lo que costó.
 *  - `thin`       margen 0–10%: no pierde, pero no paga la operación.
 *  - `no_cost`    tiene precio y no hay costo con qué juzgarlo.
 */
export type PriceHealthFlag = 'sentinel' | 'below_cost' | 'thin' | 'no_cost';

const SENTINEL_MAX = 0.05;
const THIN_MARGIN_MAX = 0.1;

/**
 * Un solo lugar define cada predicado. `listPrices` (filtro) y
 * `listPriceListsHealth` (contadores) leen de acá, así que el chip que dice
 * "164 bajo costo" y la tabla que sale al hacerle clic no pueden discrepar.
 */
const PRICE_HEALTH_SQL: Record<PriceHealthFlag, string> = {
  sentinel: `pp.price <= ${SENTINEL_MAX}`,
  below_cost: `pp.price > ${SENTINEL_MAX} AND p.cost_base > 0 AND pp.price < p.cost_base`,
  thin: `pp.price > ${SENTINEL_MAX} AND p.cost_base > 0 AND pp.price >= p.cost_base
         AND (pp.price - p.cost_base) / pp.price < ${THIN_MARGIN_MAX}`,
  no_cost: `pp.price > ${SENTINEL_MAX} AND COALESCE(p.cost_base, 0) = 0`,
};

/**
 * Columnas ordenables. Whitelist explícita: el `sort` llega del query string y
 * termina en `orderByRaw`, así que nada que no esté acá toca el SQL.
 */
const PRICE_SORT_SQL: Record<string, string> = {
  product: 'p.nombre',
  sku: 'p.sku',
  category: 'cat.name',
  rotation: 'p.sales_units_30d',
  cost: 'p.cost_base',
  price: 'pp.price',
  margin: '(pp.price - p.cost_base) / NULLIF(pp.price, 0)',
  min_qty: 'pp.min_qty',
};

// ─────────── regex ───────────

const CODE_REGEX = /^[A-Z0-9_-]{2,50}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CommercialPricingService {
  private readonly logger = new Logger(CommercialPricingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Para customer_b2b: devuelve el set de price_list_ids permitidos (su
   * default_price_list + tenant default por fallback). Para otros roles
   * devuelve null (acceso completo).
   */
  private async allowedPriceListIdsForCtx(trx: any): Promise<string[] | null> {
    const ctx = this.tenantCtx.get();
    if (ctx?.roleName !== 'customer_b2b') return null;

    const userRow = await trx('identity.users')
      .where({ id: ctx.userId })
      .select('customer_id')
      .first();
    if (!userRow?.customer_id) {
      throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
    }

    const customer = await trx('commercial.customers')
      .where({ id: userRow.customer_id })
      .select('default_price_list_id')
      .first();

    const tenantDefault = await trx('commercial.price_lists')
      .where({ is_default: true, active: true })
      .whereNull('deleted_at')
      .select('id')
      .first();

    const ids = new Set<string>();
    if (customer?.default_price_list_id) ids.add(customer.default_price_list_id);
    if (tenantDefault?.id) ids.add(tenantDefault.id);
    return Array.from(ids);
  }

  // ───── price_lists ─────

  async createPriceList(dto: CreatePriceListDto) {
    this.validatePriceListCreate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.price_lists')
        .where({ code: dto.code })
        .first();
      if (existing) {
        throw new ConflictException(
          `Ya existe price_list con code "${dto.code}"`,
        );
      }

      if (dto.is_default) await this.clearDefaultPriceList(trx);

      const [row] = await trx('commercial.price_lists')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code: dto.code,
          name: dto.name.trim(),
          currency: (dto.currency || 'MXN').toUpperCase(),
          valid_from: dto.valid_from || null,
          valid_to: dto.valid_to || null,
          is_default: dto.is_default ?? false,
          active: dto.active ?? true,
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  async listPriceLists(active?: boolean) {
    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      let q = trx('commercial.price_lists').whereNull('deleted_at');
      if (typeof active === 'boolean') q = q.where({ active });
      if (allowed !== null) {
        if (allowed.length === 0) return [];
        q = q.whereIn('id', allowed);
      }
      return q.orderBy('is_default', 'desc').orderBy('name', 'asc');
    });
  }

  async findPriceListById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      if (allowed !== null && !allowed.includes(id)) {
        throw new ForbiddenException('No tenés acceso a esta price list');
      }
      const row = await trx('commercial.price_lists')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`PriceList ${id} no encontrada`);
      return row;
    });
  }

  async updatePriceList(id: string, dto: UpdatePriceListDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    this.validatePriceListUpdate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.price_lists')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`PriceList ${id} no encontrada`);

      if (dto.code && dto.code !== existing.code) {
        const dup = await trx('commercial.price_lists')
          .where({ code: dto.code })
          .whereNot({ id })
          .first();
        if (dup) throw new ConflictException(`code duplicado: ${dto.code}`);
      }

      if (dto.is_default === true && !existing.is_default) {
        await this.clearDefaultPriceList(trx);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.code !== undefined) patch.code = dto.code;
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.currency !== undefined)
        patch.currency = (dto.currency || 'MXN').toUpperCase();
      if (dto.valid_from !== undefined) patch.valid_from = dto.valid_from || null;
      if (dto.valid_to !== undefined) patch.valid_to = dto.valid_to || null;
      if (dto.is_default !== undefined) patch.is_default = dto.is_default;
      if (dto.active !== undefined) patch.active = dto.active;
      if (dto.notes !== undefined) patch.notes = dto.notes || null;

      const [row] = await trx('commercial.price_lists')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  async softDeletePriceList(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const pl = await trx('commercial.price_lists')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!pl) throw new NotFoundException(`PriceList ${id} no encontrada`);

      if (pl.is_default) {
        throw new ConflictException(
          'No se puede borrar la price_list default. Marcar otra como default primero.',
        );
      }

      await trx('commercial.price_lists')
        .where({ id })
        .update({ deleted_at: trx.fn.now(), active: false });
      return { deleted: true, id };
    });
  }

  // ───── product_prices ─────

  /**
   * Lista precios de una price list (paginado).
   *
   * J.6.7: si `warehouseId` viene, LEFT JOIN con `commercial.stock` y devuelve
   * `stock_available` por producto. Si no viene, `stock_available` queda como
   * `null` (mantiene compatibilidad con callers que no necesitan stock).
   *
   * Sprint M: agregado `search` (ilike sobre product_name, sku, barcode) +
   * paginación (default 100/page, max 500). Sin esto, listas con miles de
   * SKUs (post-importer Mega_Dulces ~6500 en MAYOREO) colapsan el browser.
   *
   * Returns `{ data, pagination }` siempre — antes era array crudo, los callers
   * necesitan actualizar a `.data`.
   *
   * `unpricedOnly` es el complemento de `pricedOnly`: la cola de trabajo "falta
   * ponerle precio en esta lista". `flag` filtra por salud del precio y `sort`
   * ordena en servidor — ambos existen porque la tabla es lazy/paginada: ordenar
   * o filtrar en cliente sólo tocaría la página visible y mentiría.
   */
  async listPrices(
    priceListId: string,
    opts: {
      warehouseId?: string;
      page?: number;
      pageSize?: number;
      search?: string;
      commercialOnly?: boolean;
      pricedOnly?: boolean;
      unpricedOnly?: boolean;
      flag?: PriceHealthFlag;
      sort?: string;
      dir?: 'asc' | 'desc';
    } = {},
  ) {
    if (!UUID_REGEX.test(priceListId))
      throw new BadRequestException('price_list_id inválido');
    const warehouseId = opts.warehouseId;
    if (warehouseId !== undefined && warehouseId !== null && !UUID_REGEX.test(warehouseId)) {
      throw new BadRequestException('warehouse_id inválido');
    }

    const page = Math.max(1, Number(opts.page) || 1);
    const pricedOnly = opts.pricedOnly === true;
    const unpricedOnly = opts.unpricedOnly === true;
    // Techo único de 10k. Antes era 500 salvo con priced_only — pero el filtro no
    // cambia el costo del query (mismos joins, un WHERE de más), así que el techo
    // partido sólo servía para truncar en silencio al exportar el catálogo completo.
    const pageSize = Math.min(10000, Math.max(1, Number(opts.pageSize) || 100));
    const offset = (page - 1) * pageSize;
    const search = (opts.search || '').trim();
    const commercialOnly = opts.commercialOnly === true;
    const flag = PRICE_HEALTH_SQL[opts.flag as PriceHealthFlag] ? opts.flag : undefined;

    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      if (allowed !== null && !allowed.includes(priceListId)) {
        throw new ForbiddenException('No tenés acceso a esta price list');
      }

      // Source of truth: `catalog.products` (catálogo completo).
      // `commercial.product_prices` se une por LEFT JOIN para traer el precio del
      // price_list del customer si existe — null si no hay (frontend ya maneja
      // ese caso ocultando el botón "agregar" y mostrando "Sin precio").
      const buildBaseQuery = () => {
        let q = trx('catalog.products as p')
          .leftJoin('commercial.product_prices as pp', function () {
            this.on('pp.product_id', '=', 'p.id')
              .andOn('pp.tenant_id', '=', 'p.tenant_id')
              .andOnVal('pp.price_list_id', priceListId)
              .andOnNull('pp.deleted_at');
          })
          .leftJoin('catalog.brands as b', function () {
            this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
          })
          .leftJoin('catalog.categories as cat', function () {
            this.on('cat.id', '=', 'p.category_id').andOn('cat.tenant_id', '=', 'p.tenant_id');
          })
          // Imagen del producto vive en inventory.products_active (no en catalog.products
          // que solo es el planograma). JOIN por SKU, fallback a `articulo` en rows
          // de Railway donde sku está NULL (drift histórico del ERP).
          .leftJoin('inventory.products_active as ipa', function () {
            this.on(trx.raw('ipa.sku = COALESCE(p.sku, p.articulo)'));
          })
          .whereNull('p.deleted_at');

        if (commercialOnly) {
          q = q.where(function () {
            this.where('b.is_commercial', true).orWhereNull('b.is_commercial');
          });
        }

        // priced_only: solo productos con precio en ESTA price list (pedibles).
        if (pricedOnly) {
          q = q.whereNotNull('pp.price');
        }
        // unpriced_only: la cola de "falta preciar". Excluyentes por definición;
        // si llegan los dos, gana priced_only (el caller está confundido, pero el
        // catálogo pedible es el default menos sorpresivo).
        else if (unpricedOnly) {
          q = q.whereNull('pp.price');
        }

        if (flag) {
          q = q.whereRaw(`(${PRICE_HEALTH_SQL[flag]})`);
        }

        if (search) {
          const term = `%${search}%`;
          q = q.where((b) =>
            b.where('p.nombre', 'ilike', term)
              .orWhere('p.sku', 'ilike', term)
              .orWhere('p.barcode', 'ilike', term),
          );
        }
        return q;
      };

      // Count primero (sin joins de stock para no inflar el count).
      const [{ total }] = await buildBaseQuery().count<{ total: string }[]>('p.id as total');

      // Página real con joins completos.
      let q = buildBaseQuery();
      if (warehouseId) {
        q = q.leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'p.id')
            .andOn('s.tenant_id', '=', 'p.tenant_id')
            .andOnVal('s.warehouse_id', warehouseId);
        });
      }

      const selects: any[] = [
        // `pp.id` puede ser null si no hay precio configurado — usamos `p.id` como
        // identidad estable de fila (alineado con frontend trackBy product_id).
        trx.raw('COALESCE(pp.id, p.id) AS id'),
        trx.raw('p.id AS product_id'),
        'p.nombre as product_name',
        'p.description as product_description',
        'p.sku',
        'p.barcode',
        'p.brand_id as brand_id',
        'b.nombre as brand_name',
        'p.category_id',
        'cat.name as category_name',
        'p.cost_base',
        'p.cost_with_tax',
        'p.cost_per_case',
        'p.sales_units_30d',
        'p.rotation_tier',
        'p.location',
        'p.loyalty_points',
        'ipa.image_url as image_url',
        'pp.price',
        'pp.tax_rate',
        trx.raw('COALESCE(pp.min_qty, 1) AS min_qty'),
      ];
      if (warehouseId) {
        selects.push(
          trx.raw(
            'CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0) END AS stock_available',
          ),
        );
      } else {
        selects.push(trx.raw('NULL::int AS stock_available'));
      }

      // Orden: whitelist + NULLS LAST siempre (un producto sin costo no debe
      // encabezar "peor margen") y desempate estable por nombre para que dos
      // páginas consecutivas no repitan ni se salten filas.
      const sortExpr = PRICE_SORT_SQL[opts.sort ?? ''];
      const dir = opts.dir === 'desc' ? 'DESC' : 'ASC';
      const orderBy = sortExpr
        ? `${sortExpr} ${dir} NULLS LAST, p.nombre ASC`
        : 'p.nombre ASC';

      const data = await q
        .select(...selects)
        .orderByRaw(orderBy)
        .limit(pageSize)
        .offset(offset);

      // Anti-leak: el costo (margen) NUNCA se devuelve a customer_b2b — este
      // endpoint es compartido con el Portal B2B. Solo lo ve el vendedor/admin
      // en take-order. La rotación (sales_units_30d / rotation_tier) no es
      // sensible y queda visible para todos.
      const rows = this.stripCostIfCustomer(data);

      // Incitar mayoreo: adjuntar la escalera de quiebres por cantidad a cada fila
      // para que el app muestre "mayoreo desde N → $X (−Y%)" y viaje en el catálogo
      // offline. Query APARTE (no en el JOIN principal) y en try/catch: la vista
      // `analytics.product_volume_tiers` es una dependencia sobre kepler_ods; si
      // falla o no existe, el catálogo sigue vivo (solo se pierde el nudge, nunca
      // el pedido). Solo emite descuentos reales (min_qty>1 AND price<BASE).
      const productIds = rows.map((r: any) => r.product_id).filter(Boolean);
      if (productIds.length) {
        try {
          const tierRows = await trx('analytics.product_volume_tiers')
            .whereIn('product_id', productIds)
            .select('product_id', 'min_qty', 'price')
            .orderBy(['product_id', 'min_qty']);
          const byProduct = new Map<string, Array<{ min_qty: number; price: number }>>();
          for (const t of tierRows as Array<{ product_id: string; min_qty: number; price: number }>) {
            const arr = byProduct.get(t.product_id) ?? [];
            arr.push({ min_qty: Number(t.min_qty), price: Number(t.price) });
            byProduct.set(t.product_id, arr);
          }
          for (const r of rows as any[]) r.tiers = byProduct.get(r.product_id) ?? [];
        } catch (err) {
          this.logger.warn(
            `product_volume_tiers no disponible para el catálogo; filas sin nudge de mayoreo. ${String((err as Error)?.message ?? err)}`,
          );
        }
      }

      const totalNum = Number(total) || 0;
      return {
        data: rows,
        pagination: {
          page,
          pageSize,
          total: totalNum,
          pageCount: Math.ceil(totalNum / pageSize) || 0,
        },
      };
    });
  }

  /**
   * Salud de TODAS las price lists en una sola consulta.
   *
   * Se construye sobre el mismo eje que `listPrices` — `catalog.products` como
   * tabla que manda, precio por LEFT JOIN — para que los contadores describan
   * exactamente las filas que la tabla puede mostrar. Con la unión al revés
   * (partir de `product_prices`) los números salían más altos: hay precios
   * apuntando a productos ya borrados, que la tabla nunca pinta.
   */
  async listPriceListsHealth() {
    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      if (allowed !== null && allowed.length === 0) return { data: [] };

      const count = (sql: string, alias: string) =>
        trx.raw(`COUNT(*) FILTER (WHERE ${sql})::int AS ${alias}`);

      let q = trx('commercial.price_lists as pl')
        // crossJoin tipa el argumento como Raw en esta versión de knex: un string
        // con alias no compila.
        .crossJoin(trx.raw('catalog.products as p'))
        .leftJoin('commercial.product_prices as pp', function () {
          this.on('pp.product_id', '=', 'p.id')
            .andOn('pp.tenant_id', '=', 'p.tenant_id')
            .andOn('pp.price_list_id', '=', 'pl.id')
            .andOnNull('pp.deleted_at');
        })
        .whereNull('pl.deleted_at')
        .whereNull('p.deleted_at')
        .whereRaw('pl.tenant_id = p.tenant_id');

      if (allowed !== null) q = q.whereIn('pl.id', allowed);

      const rows = await q
        .groupBy('pl.id')
        .select(
          'pl.id as price_list_id',
          trx.raw('COUNT(*)::int AS catalog'),
          trx.raw('COUNT(pp.price)::int AS priced'),
          count('pp.price IS NULL', 'unpriced'),
          count(PRICE_HEALTH_SQL.sentinel, 'sentinel'),
          count(PRICE_HEALTH_SQL.below_cost, 'below_cost'),
          count(PRICE_HEALTH_SQL.thin, 'thin'),
          count(PRICE_HEALTH_SQL.no_cost, 'no_cost'),
          // Frescura: el precio lo sincroniza Kepler, así que "cuándo se movió
          // esta lista por última vez" es lo que dice si está viva o congelada.
          trx.raw('MAX(pp.updated_at) AS last_price_update'),
        );

      // Mismo criterio anti-leak que listPrices: los contadores de margen son
      // costo derivado. Devolver "164 bajo costo" a un customer_b2b le diría
      // cuánto le cuesta a Mega Dulces lo que le vende.
      return {
        data: this.isCustomerB2b()
          ? rows.map(({ below_cost, thin, no_cost, ...r }: any) => r)
          : rows,
      };
    });
  }

  /**
   * Top sellers para una price_list. Lee de `catalog.top_sellers_live`,
   * alimentada por la venta REAL consolidada de las 6 sucursales
   * (import-top-sellers-from-consolidado.js, ventana 90d) en vez del ranking
   * stale del ERP. El MV viejo `catalog.products_top_sellers` queda intacto.
   * Joinea con `commercial.product_prices` del price_list para devolver el
   * precio del customer + sales_rank + units_sold.
   *
   * Customer_b2b sólo puede pedirla sobre SU price_list (allowedPriceListIdsForCtx).
   * Si no hay ventas todavía la MV devuelve pocos rows (es esperable hasta que
   * Mega Dulces tenga volumen real).
   */
  async listTopSellers(
    priceListId: string,
    opts: { warehouseId?: string; limit?: number } = {},
  ) {
    if (!UUID_REGEX.test(priceListId))
      throw new BadRequestException('price_list_id inválido');
    const warehouseId = opts.warehouseId;
    if (warehouseId !== undefined && warehouseId !== null && !UUID_REGEX.test(warehouseId)) {
      throw new BadRequestException('warehouse_id inválido');
    }
    const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 1000));

    return this.tk.run(async (trx) => {
      const allowed = await this.allowedPriceListIdsForCtx(trx);
      if (allowed !== null && !allowed.includes(priceListId)) {
        throw new ForbiddenException('No tenés acceso a esta price list');
      }

      // INNER JOIN con product_prices: solo devolvemos top sellers que tienen
      // precio configurado en la price_list del customer. Garantiza que cada
      // card del portal sea comprable (sin "Sin precio"). MV ya viene filtrada
      // por productos_activos del ERP, así que no requiere brand.is_commercial.
      let q = trx('catalog.top_sellers_live as ts')
        .innerJoin('commercial.product_prices as pp', function () {
          this.on('pp.product_id', '=', 'ts.id')
            .andOn('pp.tenant_id', '=', 'ts.tenant_id')
            .andOnVal('pp.price_list_id', priceListId)
            .andOnNull('pp.deleted_at');
        })
        .leftJoin('catalog.brands as b', function () {
          this.on('b.id', '=', 'ts.brand_id').andOn('b.tenant_id', '=', 'ts.tenant_id');
        })
        .leftJoin('catalog.categories as cat', function () {
          this.on('cat.id', '=', 'ts.category_id').andOn('cat.tenant_id', '=', 'ts.tenant_id');
        })
        // Imagen desde inventory.products_active (single source of truth para fotos)
        .leftJoin('inventory.products_active as ipa', 'ipa.sku', 'ts.sku');

      if (warehouseId) {
        q = q.leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'ts.id')
            .andOn('s.tenant_id', '=', 'ts.tenant_id')
            .andOnVal('s.warehouse_id', warehouseId);
        });
      }

      const selects: any[] = [
        trx.raw('pp.id AS id'),
        trx.raw('ts.id AS product_id'),
        'ts.nombre as product_name',
        'ts.sku',
        'ts.barcode',
        'ts.brand_id',
        'b.nombre as brand_name',
        'ts.category_id',
        'cat.name as category_name',
        'ts.cost_base',
        'ipa.image_url as image_url',
        'pp.price',
        'pp.tax_rate',
        trx.raw('COALESCE(pp.min_qty, 1) AS min_qty'),
        'ts.sales_rank',
        'ts.units_sold',
        'ts.revenue',
        'ts.cases_sold',
        'ts.units_total',
      ];
      if (warehouseId) {
        selects.push(
          trx.raw(
            'CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0) END AS stock_available',
          ),
        );
      } else {
        selects.push(trx.raw('NULL::int AS stock_available'));
      }

      const data = await q
        .select(...selects)
        .orderBy('ts.sales_rank', 'asc')
        .limit(limit);

      return { data: this.stripCostIfCustomer(data), total: data.length };
    });
  }

  async bulkUpsertPrices(dto: BulkUpsertProductPricesDto) {
    if (!UUID_REGEX.test(dto.price_list_id))
      throw new BadRequestException('price_list_id inválido');
    if (!Array.isArray(dto.items) || dto.items.length === 0)
      throw new BadRequestException('items debe ser array no vacío');
    if (dto.items.length > 1000)
      throw new BadRequestException('máximo 1000 items por bulk upsert');

    for (const it of dto.items) this.validatePriceItem(it);

    return this.tk.run(async (trx) => {
      // Verificar que la price_list existe
      const pl = await trx('commercial.price_lists')
        .where({ id: dto.price_list_id })
        .whereNull('deleted_at')
        .first();
      if (!pl)
        throw new NotFoundException(`PriceList ${dto.price_list_id} no encontrada`);

      /**
       * Un item que NO manda `min_qty`/`tax_rate` pide "cambiá el precio", NO
       * "reseteá el mínimo a 1 y el IVA a 16%". Antes ambos viajaban con su
       * default y entraban al MERGE, así que editar una celda de precio en
       * /comercial/pricing (que sólo manda `{ product_id, price }`) borraba el
       * quiebre por volumen del SKU. Con `resolvePriceForQty` eligiendo el
       * precio MÁS BAJO con `min_qty <= qty`, ese reset dejaba el precio de
       * mayoreo disponible comprando 1 pieza.
       *
       * Se agrupa por el set de campos presentes y cada grupo mergea SÓLO lo
       * que trajo. Los ausentes se omiten de la sentencia: en filas nuevas los
       * pone el DEFAULT de la columna (1 / 0.16) y en filas existentes quedan
       * intactos.
       */
      const groups = new Map<string, UpsertProductPriceDto[]>();
      for (const it of dto.items) {
        const key = OPTIONAL_PRICE_FIELDS.filter((f) => it[f] !== undefined).join(',');
        const g = groups.get(key);
        if (g) g.push(it);
        else groups.set(key, [it]);
      }

      let upserted = 0;
      for (const [key, items] of groups) {
        const present = (key ? key.split(',') : []) as OptionalPriceField[];

        const rows = items.map((it) => {
          const row: Record<string, any> = {
            tenant_id: trx.raw('public.current_tenant_id()'),
            price_list_id: dto.price_list_id,
            product_id: it.product_id,
            price: it.price,
            updated_at: trx.fn.now(),
          };
          for (const f of present) row[f] = it[f];
          return row;
        });

        const merge: Record<string, any> = {
          price: trx.raw('EXCLUDED.price'),
          updated_at: trx.fn.now(),
          // Upsertar un precio es afirmar que existe. Sin esto, quitar un precio
          // y volver a ponerlo escribía la fila y la dejaba invisible: el unique
          // es (tenant, lista, producto) sin `deleted_at`, y `listPrices` joinea
          // con `pp.deleted_at IS NULL`.
          deleted_at: null,
          deleted_by: null,
        };
        for (const f of present) merge[f] = trx.raw(`EXCLUDED.${f}`);

        const inserted = await trx('commercial.product_prices')
          .insert(rows)
          .onConflict(['tenant_id', 'price_list_id', 'product_id'])
          .merge(merge)
          .returning('id');
        upserted += inserted.length;
      }

      return { upserted };
    });
  }

  async deletePrice(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.product_prices')
        .where({ id })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now() })
        .returning('id');
      if (!row) throw new NotFoundException(`ProductPrice ${id} no encontrado`);
      return { deleted: true, id };
    });
  }

  /**
   * Resuelve precio aplicable a un producto para un cliente:
   *   1. Si el cliente tiene default_price_list_id, busca ahí.
   *   2. Fallback: busca en la price_list default del tenant.
   *   3. Si nada existe, devuelve null (el caller decide si bloquea el pedido).
   */
  async resolvePriceForCustomer(productId: string, customerId: string) {
    if (!UUID_REGEX.test(productId))
      throw new BadRequestException('product_id inválido');
    if (!UUID_REGEX.test(customerId))
      throw new BadRequestException('customer_id inválido');

    return this.tk.run(async (trx) => {
      // Defense in depth: si el rol es customer_b2b, sobrescribir customerId
      // con el customer del JWT. Sin esto un customer_b2b autenticado podría
      // consultar el precio que paga OTRO cliente para cualquier producto
      // pasando ?customer_id=<otro_uuid> — leak de pricing competitivo.
      const ctx = this.tenantCtx.get();
      if (ctx?.roleName === 'customer_b2b') {
        const userRow = await trx('identity.users')
          .where({ id: ctx.userId })
          .select('customer_id')
          .first();
        if (!userRow?.customer_id) {
          throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
        }
        customerId = userRow.customer_id;
      }

      const customer = await trx('commercial.customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first();
      if (!customer)
        throw new NotFoundException(`Customer ${customerId} no encontrado`);

      const tryPriceList = async (priceListId: string | null) => {
        if (!priceListId) return null;
        return trx('commercial.product_prices')
          .where({ price_list_id: priceListId, product_id: productId })
          .whereNull('deleted_at')
          .first();
      };

      let price = await tryPriceList(customer.default_price_list_id);
      let source: 'customer_default' | 'tenant_default' | null = price
        ? 'customer_default'
        : null;

      if (!price) {
        const tenantDefault = await trx('commercial.price_lists')
          .where({ is_default: true, active: true })
          .whereNull('deleted_at')
          .first();
        if (tenantDefault) {
          price = await tryPriceList(tenantDefault.id);
          if (price) source = 'tenant_default';
        }
      }

      if (!price) {
        return {
          product_id: productId,
          customer_id: customerId,
          price: null,
          tax_rate: null,
          min_qty: null,
          source: null,
        };
      }

      return {
        product_id: productId,
        customer_id: customerId,
        price_list_id: price.price_list_id,
        price: Number(price.price),
        tax_rate: Number(price.tax_rate),
        min_qty: price.min_qty,
        source,
      };
    });
  }

  /**
   * FIQ.3 (tiers de volumen) — Precio por CANTIDAD. Entre TODAS las entradas de
   * precio del producto (P1..P4/MAYOREO son quiebres por cantidad), elige la mejor
   * (MENOR precio) cuyo `min_qty <= qty`. El precio/pza depende de cuánto compra
   * (pieza suelta vs caja vs varias cajas). Modelo confirmado por el negocio:
   * "por cantidad", el precio NO depende de la lista del cliente sino del volumen.
   *
   *   - `min_purchase`: el `min_qty` más chico = mínimo absoluto de compra.
   *   - `price` null si `qty < min_purchase` (el caller reporta el mínimo).
   *
   * Determinista y read-only (ADR-016: el motor pone el número). Scope de tenant (CLS/RLS).
   */
  async resolvePriceForQty(productId: string, qty: number) {
    if (!UUID_REGEX.test(productId)) throw new BadRequestException('product_id inválido');
    const q = Math.max(1, Math.floor(Number(qty) || 1));
    return this.tk.run(async (trx) => {
      // Fix #2 mayoreo: los quiebres por CANTIDAD ya no salen de las listas
      // congeladas P1-P4/MAYOREO (fuente `catalogo_etiquetas`, freeze 2026-08-16,
      // corruptamente baratas → subcotizaban), sino de la vista viva
      // `analytics.product_volume_tiers` (derivada de kepler_ods.kdpv_prod_util;
      // min_qty>1 y siempre < BASE). El ANCLA es BASE-MXN (min1): ignoramos a
      // propósito las demás listas para que sus tiers congelados NO le ganen al
      // mayoreo real por ser más baratos. Si un producto NO tiene BASE-MXN
      // (~573 SKUs de DQ) caemos a todo lo vivo para que sigan pedibles.
      const baseAnchor = await trx('commercial.product_prices as pp')
        .join('commercial.price_lists as pl', function (this: any) {
          this.on('pl.id', '=', 'pp.price_list_id').andOn('pl.tenant_id', '=', 'pp.tenant_id');
        })
        .where('pp.product_id', productId)
        .whereNull('pp.deleted_at')
        .where('pl.code', 'BASE-MXN')
        .select('pp.price', 'pp.tax_rate', 'pp.min_qty', 'pp.price_list_id')
        .orderBy('pp.min_qty', 'asc');
      const base = baseAnchor.length
        ? baseAnchor
        : await trx('commercial.product_prices')
            .where({ product_id: productId })
            .whereNull('deleted_at')
            .select('price', 'tax_rate', 'min_qty', 'price_list_id')
            .orderBy('min_qty', 'asc');
      // El IVA de los tiers de la vista lo hereda del precio base del producto;
      // no aportan price_list_id (ningún caller de este método lo usa).
      const taxDefault = base.length ? Number(base[0].tax_rate) : 0;
      // Red de seguridad: la vista es una dependencia nueva sobre kepler_ods; si
      // falla o aún no existe, NO rompemos la toma de pedido: caemos a BASE. La
      // vista solo emite descuentos (< BASE), así que su ausencia nunca sobrecobra.
      let viewTiers: Array<{ price: number; tax_rate: number; min_qty: number; price_list_id: string | null }> = [];
      try {
        const rows = await trx('analytics.product_volume_tiers')
          .where({ product_id: productId })
          .select('price', 'min_qty');
        viewTiers = rows.map((r: { price: number; min_qty: number }) => ({
          price: Number(r.price),
          tax_rate: taxDefault,
          min_qty: Number(r.min_qty),
          price_list_id: null as string | null,
        }));
      } catch (err) {
        this.logger.warn(
          `product_volume_tiers no disponible para ${productId}; uso solo BASE. ${String((err as Error)?.message ?? err)}`,
        );
      }
      const tiers = [...base, ...viewTiers].sort(
        (a, b) => (Number(a.min_qty) || 1) - (Number(b.min_qty) || 1),
      );
      if (!tiers.length) {
        return { product_id: productId, price: null, tax_rate: null, min_qty: null, min_purchase: null, price_list_id: null, source: null as string | null };
      }
      const minPurchase = Math.max(1, Number(tiers[0].min_qty) || 1);
      const applicable = tiers.filter((t) => (Number(t.min_qty) || 1) <= q);
      if (!applicable.length) {
        // qty por debajo del mínimo de compra: sin precio aplicable, reportar el mínimo.
        return {
          product_id: productId,
          price: null,
          tax_rate: Number(tiers[0].tax_rate),
          min_qty: minPurchase,
          min_purchase: minPurchase,
          price_list_id: tiers[0].price_list_id,
          source: 'below_min' as string | null,
        };
      }
      const best = applicable.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
      return {
        product_id: productId,
        price: Number(best.price),
        tax_rate: Number(best.tax_rate),
        min_qty: minPurchase,
        min_purchase: minPurchase,
        price_list_id: best.price_list_id,
        source: 'qty_tier' as string | null,
      };
    });
  }

  // ───── helpers ─────

  /**
   * Anti-leak del margen: si el ctx es customer_b2b, anula las columnas de costo.
   * El endpoint de precios es compartido con el Portal; el costo solo lo ve el
   * vendedor/admin (take-order). La rotación no es sensible y NO se toca.
   */
  private isCustomerB2b(): boolean {
    return this.tenantCtx.get()?.roleName === 'customer_b2b';
  }

  private stripCostIfCustomer<T extends Record<string, any>>(rows: T[]): T[] {
    if (!this.isCustomerB2b()) return rows;
    return rows.map((r) => ({
      ...r,
      cost_base: null,
      cost_with_tax: null,
      cost_per_case: null,
    }));
  }

  private async clearDefaultPriceList(trx: any): Promise<void> {
    await trx('commercial.price_lists')
      .where({ is_default: true })
      .update({ is_default: false, updated_at: trx.fn.now() });
  }

  private validatePriceListCreate(dto: CreatePriceListDto): void {
    if (!dto.code || !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException('code requerido: 2-50 chars [A-Z0-9_-]');
    }
    if (!dto.name?.trim()) throw new BadRequestException('name requerido');
    if (dto.currency && !/^[A-Z]{3}$/.test(dto.currency.toUpperCase())) {
      throw new BadRequestException('currency debe ser ISO 4217 (3 letras)');
    }
  }

  private validatePriceListUpdate(dto: UpdatePriceListDto): void {
    if (dto.code !== undefined && !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException('code inválido');
    }
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('name no puede ser vacío');
    }
    if (dto.currency && !/^[A-Z]{3}$/.test(dto.currency.toUpperCase())) {
      throw new BadRequestException('currency debe ser ISO 4217');
    }
  }

  private validatePriceItem(it: UpsertProductPriceDto): void {
    if (!UUID_REGEX.test(it.product_id)) {
      throw new BadRequestException(`product_id inválido: ${it.product_id}`);
    }
    if (typeof it.price !== 'number' || it.price < 0) {
      throw new BadRequestException(`price inválido (>= 0): ${it.price}`);
    }
    if (it.tax_rate !== undefined && (it.tax_rate < 0 || it.tax_rate > 1)) {
      throw new BadRequestException(`tax_rate fuera de rango [0..1]: ${it.tax_rate}`);
    }
    if (it.min_qty !== undefined && (!Number.isInteger(it.min_qty) || it.min_qty < 1)) {
      throw new BadRequestException(`min_qty debe ser entero >= 1`);
    }
  }
}
