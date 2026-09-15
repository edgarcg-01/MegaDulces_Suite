import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

export interface ListProductsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  brand_id?: string;
  /** Multi-marca (promotor de marca propia): restringe a este set de brand_id. */
  brand_ids?: string[];
  category_id?: string;
  supplier_id?: string;
  /** Filtro por `activo` (true = solo activos, false = solo inactivos). Undefined trae ambos. */
  active?: boolean;
  /** Solo productos con costo cargado (útil para validar imports del ERP). */
  with_cost?: boolean;
  without_price?: boolean;
}

export interface UpdateProductDto {
  description?: string | null;
  location?: string | null;
  location_warehouse?: string | null;
  loyalty_points?: number | null;
  activo?: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin CRUD-ish para `public.products`. Gateado por CATALOGO_GESTIONAR porque
 * expone columnas sensibles (cost_base, cost_with_tax, cost_per_case) que NO
 * deben ser accesibles a customer_b2b ni vendedores.
 *
 * Update limitado a campos editables manualmente por admin (description,
 * location, loyalty_points, activo). Los costos, precios, SKU, brand vienen
 * del importer Mega_Dulces — modificarlos manual rompe la consistencia con
 * el ERP. Si el admin quiere cambiar un costo, lo hace en el ERP origen.
 */
@Injectable()
export class CommercialProductsService {
  constructor(private readonly tk: TenantKnexService) {}

  async list(query: ListProductsQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    const search = (query.search || '').trim();

    return this.tk.run(async (trx) => {
      const buildBase = () => {
        let q = trx('products as p')
          .leftJoin('brands as b', function () {
            this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
          })
          .leftJoin('categories as cat', function () {
            this.on('cat.id', '=', 'p.category_id').andOn('cat.tenant_id', '=', 'p.tenant_id');
          })
          // La vista public.products NO expone supplier_id → join a la tabla base catalog.products
          // (mismo id, RLS scoped por tk.run) para poder filtrar/mostrar proveedor sin recrear la vista.
          .leftJoin('catalog.products as cp', function () {
            this.on('cp.id', '=', 'p.id').andOn('cp.tenant_id', '=', 'p.tenant_id');
          })
          .leftJoin('catalog.suppliers as sup', function () {
            this.on('sup.id', '=', 'cp.supplier_id').andOn('sup.tenant_id', '=', 'cp.tenant_id');
          })
          // [RP.12] El PRECIO AL CLIENTE. Se toma de la lista BASE-MXN y no de P1 —que es la que
          // se LLAMA "precio publico"— porque es la que coincide con lo que cobra la caja: medido
          // contra produccion, el SKU 08002 CARLOS V sale a 60.24 en BASE-MXN y la lectura real de
          // 8 Esquinas fue 60.22; P1 dice 55.77. El nombre miente, el dato no.
          //
          // NO abanica: product_prices tiene UNIQUE (tenant, price_list, product), verificado
          // ademas por conteo (BASE-MXN = 9,521 filas sobre 9,521 productos, 1:1).
          //
          // OJO, esto es interino. La fuente buena es analytics.v_price_for_qty (derive-no-copy
          // sobre kepler_ods), que da el precio POR SUCURSAL y su escalera de mayoreo; esta lista
          // la llena un importer desde la DB legacy Mega_Dulces y NO tiene sucursal. Por eso la
          // pantalla publica junto al precio la fecha en que se actualizo: un numero sin sucursal
          // y con semanas de rezago se declara, no se disimula.
          .leftJoin('commercial.price_lists as pl_pv', function () {
            this.on('pl_pv.tenant_id', '=', 'p.tenant_id')
              .andOnVal('pl_pv.code', '=', 'BASE-MXN')
              .andOnNull('pl_pv.deleted_at');
          })
          .leftJoin('commercial.product_prices as pv', function () {
            this.on('pv.tenant_id', '=', 'p.tenant_id')
              .andOn('pv.product_id', '=', 'p.id')
              .andOn('pv.price_list_id', '=', 'pl_pv.id')
              .andOnNull('pv.deleted_at');
          })
          .whereNull('p.deleted_at');

        if (search) {
          const term = `%${search}%`;
          q = q.where((b) =>
            b.where('p.nombre', 'ilike', term)
              .orWhere('p.sku', 'ilike', term)
              .orWhere('p.barcode', 'ilike', term)
              .orWhere('p.description', 'ilike', term),
          );
        }
        if (query.brand_id) {
          if (!UUID_REGEX.test(query.brand_id)) throw new BadRequestException('brand_id inválido');
          q = q.where('p.brand_id', query.brand_id);
        }
        if (query.brand_ids?.length) {
          const ids = query.brand_ids.filter((b) => UUID_REGEX.test(b));
          // Set vacío/ inválido → no matchear nada (evita "traer todo" si el scoping falla).
          q = ids.length ? q.whereIn('p.brand_id', ids) : q.whereRaw('false');
        }
        if (query.category_id) {
          if (!UUID_REGEX.test(query.category_id)) throw new BadRequestException('category_id inválido');
          q = q.where('p.category_id', query.category_id);
        }
        if (query.supplier_id) {
          if (!UUID_REGEX.test(query.supplier_id)) throw new BadRequestException('supplier_id inválido');
          q = q.where('cp.supplier_id', query.supplier_id);
        }
        if (typeof query.active === 'boolean') {
          q = q.where('p.activo', query.active);
        }
        if (query.with_cost) {
          q = q.whereNotNull('p.cost_base');
        }
        if (query.without_price) {
          // El hueco que importa al comprador: producto activo que no tiene precio publicado.
          q = q.whereNull('pv.price');
        }
        return q;
      };

      const [{ total }] = await buildBase().count<{ total: string }[]>('p.id as total');

      const data = await buildBase()
        .select(
          'p.id',
          'p.sku',
          'p.barcode',
          'p.nombre',
          'p.description',
          'p.brand_id',
          'b.nombre as brand_name',
          'p.category_id',
          'cat.name as category_name',
          'cp.supplier_id',
          'sup.name as supplier_name',
          'p.unit_purchase',
          'p.unit_sale',
          'p.factor_purchase',
          'p.factor_sale',
          'p.iva_rate',
          'p.ieps_rate',
          'p.cost_base',
          'p.cost_with_tax',
          'p.cost_per_case',
          'pv.price as price_customer',
          'pv.min_qty as price_min_qty',
          'pv.updated_at as price_updated_at',
          'p.location',
          'p.location_warehouse',
          'p.loyalty_points',
          'p.activo',
          'p.updated_at',
        )
        .orderBy('p.nombre', 'asc')
        .limit(pageSize)
        .offset(offset);

      const totalNum = Number(total) || 0;
      return {
        data,
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
   * Proveedores que tienen al menos un producto (para el dropdown del filtro). Devuelve
   * id + nombre + # de productos, orden alfabético. `p.supplier_id` vive en catalog.products
   * (la vista public.products no lo expone), scoped por RLS vía tk.run.
   */
  async suppliers() {
    return this.tk.run(async (trx) =>
      trx('catalog.products as p')
        .join('catalog.suppliers as s', function () {
          this.on('s.id', '=', 'p.supplier_id').andOn('s.tenant_id', '=', 'p.tenant_id');
        })
        .whereNull('p.deleted_at')
        .whereNull('s.deleted_at')
        .groupBy('s.id', 's.name')
        .select('s.id', 's.name', trx.raw('COUNT(p.id)::int AS product_count'))
        .orderBy('s.name', 'asc'),
    );
  }

  /**
   * `[CAT.2]` **Códigos de barras repetidos** — el mismo código dado de alta en más de un producto.
   *
   * Al escanear, la caja tiene dos altas para el mismo código y **cobra la que le toque, en el
   * mismo mostrador y el mismo día**. Y aunque el precio coincida, la venta se descuenta del SKU
   * equivocado: el inventario se desangra en silencio.
   *
   * ⚠️ NO depende de que haya precios, y eso es deliberado. Un código repetido es una propiedad de
   * `catalog.product_barcodes` SOLA ("este código está en dos altas"); el precio es CONTEXTO —dice
   * si ADEMÁS cobran distinto—, no un requisito. La primera versión de esta pantalla lo sacaba de
   * una vista de precios y por eso mostraba **0 códigos repetidos** en una base que tenía 56: un
   * defecto detectable que desaparece en silencio se lee como "acá está todo bien".
   *
   * El contexto sale de `commercial.product_label_prices`, que el hop-2 escribe desde el ODS y que
   * desde `[NORM.3]` tiene grano **por sucursal** — así el rango min/max es la dispersión real
   * entre plazas, no un promedio. Se lee con `LEFT JOIN` y su ausencia se declara
   * (`precios_disponibles`), nunca se dibuja como cero.
   *
   * ⭐ El agregado por SKU va en un CTE aparte a propósito: `product_label_prices` tiene una fila
   * por sucursal, así que unirla directo multiplicaría cada alta por plaza y los conteos mentirían.
   *
   * Sólo Kepler (`source LIKE 'kepler%'`): Wincaja se retira y sus códigos no deben ensuciar el
   * diagnóstico.
   */
  async duplicateBarcodes(query: { search?: string; limit?: number } = {}) {
    const search = (query.search || '').trim();
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);

    return this.tk.run(async (trx) => {
      const chk = await trx.raw(`
        SELECT to_regclass('commercial.product_label_prices') IS NOT NULL AS tabla,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'commercial' AND table_name = 'product_label_prices'
                          AND column_name = 'sucursal') AS por_sucursal`);
      const conPrecio = chk.rows[0]?.tabla === true;
      const porSucursal = chk.rows[0]?.por_sucursal === true;

      const cte = conPrecio
        ? `, pr AS (
             SELECT lp.product_id,
                    min(lp.piece_price) AS precio_min,
                    max(lp.piece_price) AS precio_max,
                    ${porSucursal ? 'count(DISTINCT lp.sucursal)::int' : '1'} AS sucursales
               FROM commercial.product_label_prices lp
              WHERE lp.piece_price IS NOT NULL AND lp.piece_price > 0
              GROUP BY lp.product_id
           )`
        : `, pr AS (SELECT NULL::uuid AS product_id, NULL::numeric AS precio_min,
                          NULL::numeric AS precio_max, 0::int AS sucursales WHERE false)`;

      const filtro = search
        ? `AND (b.barcode ILIKE :q OR b.sku ILIKE :q OR p.nombre ILIKE :q)`
        : '';

      const { rows } = await trx.raw(
        `
        WITH dup AS (
          SELECT btrim(barcode) AS barcode
            FROM catalog.product_barcodes
           WHERE deleted_at IS NULL AND activo IS TRUE
             AND source LIKE 'kepler%' AND btrim(coalesce(barcode, '')) <> ''
           GROUP BY btrim(barcode)
          HAVING count(DISTINCT sku) > 1
        )${cte}
        SELECT d.barcode,
               count(DISTINCT b.sku)::int AS altas,
               json_agg(DISTINCT jsonb_build_object(
                 'sku', b.sku, 'nombre', p.nombre, 'unit', b.unit, 'activo', p.activo,
                 'supplier_name', s.name,
                 'precio_min', pr.precio_min, 'precio_max', pr.precio_max,
                 'sucursales', coalesce(pr.sucursales, 0)
               )) AS productos,
               min(pr.precio_min) AS precio_min,
               max(pr.precio_max) AS precio_max
          FROM dup d
          JOIN catalog.product_barcodes b
            ON btrim(b.barcode) = d.barcode
           AND b.deleted_at IS NULL AND b.activo IS TRUE AND b.source LIKE 'kepler%'
          LEFT JOIN catalog.products p ON p.sku = b.sku AND p.deleted_at IS NULL
          LEFT JOIN catalog.suppliers s ON s.id = p.supplier_id
          LEFT JOIN pr ON pr.product_id = p.id
         WHERE true ${filtro}
         GROUP BY d.barcode
         ORDER BY (max(pr.precio_max) - min(pr.precio_min)) DESC NULLS LAST, d.barcode
         LIMIT :lim
        `,
        search ? { q: `%${search}%`, lim: limit } : { lim: limit },
      );

      return {
        total: rows.length,
        // Se publica SIEMPRE: sin esto, "0 cobran distinto" se lee igual que "no pude saberlo".
        precios_disponibles: conPrecio,
        precio_por_sucursal: porSucursal,
        rows: rows.map((r: Record<string, unknown>) => {
          const mn = r.precio_min == null ? null : Number(r.precio_min);
          const mx = r.precio_max == null ? null : Number(r.precio_max);
          return {
            barcode: String(r.barcode),
            altas: Number(r.altas),
            productos: (r.productos as unknown[]) ?? [],
            precio_min: mn,
            precio_max: mx,
            precio_conocido: mn != null,
            cobran_distinto: mn != null && mx != null && mx - mn > 0.005,
          };
        }),
      };
    });
  }

  /**
   * Agregados catálogo-wide para el KPI strip (independiente del paginado y de los
   * segmentos activo/costo de la tabla). Honra `search` para que los KPIs describan
   * el universo filtrado por texto. Incluye top marcas por # de SKU para data-viz.
   */
  async stats(search?: string) {
    const term = (search || '').trim();
    return this.tk.run(async (trx) => {
      const base = () => {
        let q = trx('products as p')
          // [RP.12] mismo join que el listado: la cobertura de precio es un KPI del catalogo,
          // no del paginado. Sin esto el "con precio" contaria la pagina, no el universo.
          .leftJoin('commercial.price_lists as pl_pv', function () {
            this.on('pl_pv.tenant_id', '=', 'p.tenant_id')
              .andOnVal('pl_pv.code', '=', 'BASE-MXN')
              .andOnNull('pl_pv.deleted_at');
          })
          .leftJoin('commercial.product_prices as pv', function () {
            this.on('pv.tenant_id', '=', 'p.tenant_id')
              .andOn('pv.product_id', '=', 'p.id')
              .andOn('pv.price_list_id', '=', 'pl_pv.id')
              .andOnNull('pv.deleted_at');
          })
          .whereNull('p.deleted_at');
        if (term) {
          const t = `%${term}%`;
          q = q.where((b) =>
            b.where('p.nombre', 'ilike', t)
              .orWhere('p.sku', 'ilike', t)
              .orWhere('p.barcode', 'ilike', t)
              .orWhere('p.description', 'ilike', t),
          );
        }
        return q;
      };

      const agg = await base()
        .select(
          trx.raw('COUNT(*)::int AS total'),
          trx.raw('COUNT(*) FILTER (WHERE p.activo)::int AS active'),
          trx.raw('COUNT(*) FILTER (WHERE NOT p.activo)::int AS inactive'),
          trx.raw('COUNT(*) FILTER (WHERE p.cost_base IS NOT NULL)::int AS with_cost'),
          trx.raw("COUNT(*) FILTER (WHERE p.location IS NOT NULL AND p.location <> '')::int AS with_location"),
          trx.raw('COUNT(DISTINCT p.brand_id)::int AS brands'),
          trx.raw('COUNT(DISTINCT p.category_id)::int AS categories'),
          trx.raw('COUNT(*) FILTER (WHERE pv.price IS NOT NULL)::int AS with_price'),
          trx.raw('MAX(pv.updated_at) AS price_updated_at'),
        )
        .first<{
          total: number; active: number; inactive: number;
          with_cost: number; with_location: number; brands: number; categories: number;
          with_price: number; price_updated_at: string | null;
        }>();

      const topBrands = await base()
        .leftJoin('brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        .whereNotNull('p.brand_id')
        .groupBy('b.nombre')
        .select('b.nombre as name', trx.raw('COUNT(p.id)::int AS sku_count'))
        .orderBy('sku_count', 'desc')
        .limit(8);

      return {
        total: agg?.total ?? 0,
        active: agg?.active ?? 0,
        inactive: agg?.inactive ?? 0,
        with_cost: agg?.with_cost ?? 0,
        with_location: agg?.with_location ?? 0,
        with_price: agg?.with_price ?? 0,
        // La pantalla lo usa para decir DESDE CUANDO no se mueve la lista. Sin este dato
        // un precio viejo se lee igual que uno de hoy.
        price_updated_at: agg?.price_updated_at ?? null,
        brands: agg?.brands ?? 0,
        categories: agg?.categories ?? 0,
        top_brands: (topBrands as { name: string | null; sku_count: number }[]).map((r) => ({
          name: r.name || 'Sin marca',
          sku_count: Number(r.sku_count),
        })),
      };
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('products as p')
        .leftJoin('brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        .leftJoin('categories as cat', function () {
          this.on('cat.id', '=', 'p.category_id').andOn('cat.tenant_id', '=', 'p.tenant_id');
        })
        .where('p.id', id)
        .whereNull('p.deleted_at')
        .first(
          'p.*',
          'b.nombre as brand_name',
          'cat.name as category_name',
        );
      if (!row) throw new NotFoundException(`Product ${id} no encontrado`);

      // Conteo de prices configurados (sin traer todos).
      const [{ count: pricesCount }] = await trx('commercial.product_prices')
        .where({ product_id: id })
        .whereNull('deleted_at')
        .count<{ count: string }[]>('* as count');

      // Stock agregado entre warehouses.
      const stockAgg = await trx('commercial.stock')
        .where({ product_id: id })
        .select(
          trx.raw('COALESCE(SUM(quantity), 0)::numeric AS total_on_hand'),
          trx.raw('COALESCE(SUM(reserved_quantity), 0)::numeric AS total_reserved'),
        )
        .first();

      return {
        ...row,
        prices_count: Number(pricesCount) || 0,
        total_on_hand: Number(stockAgg?.total_on_hand || 0),
        total_reserved: Number(stockAgg?.total_reserved || 0),
        total_available: Number(stockAgg?.total_on_hand || 0) - Number(stockAgg?.total_reserved || 0),
      };
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    this.validateUpdate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('products')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Product ${id} no encontrado`);

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.description !== undefined) patch.description = dto.description || null;
      if (dto.location !== undefined) patch.location = dto.location || null;
      if (dto.location_warehouse !== undefined) patch.location_warehouse = dto.location_warehouse || null;
      if (dto.loyalty_points !== undefined) {
        patch.loyalty_points = dto.loyalty_points == null ? null : Number(dto.loyalty_points);
      }
      if (dto.activo !== undefined) patch.activo = !!dto.activo;

      const [row] = await trx('products')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  private validateUpdate(dto: UpdateProductDto): void {
    if (dto.description !== undefined && dto.description !== null && dto.description.length > 500) {
      throw new BadRequestException('description máx 500 chars');
    }
    if (dto.location !== undefined && dto.location !== null && dto.location.length > 20) {
      throw new BadRequestException('location máx 20 chars');
    }
    if (dto.loyalty_points !== undefined && dto.loyalty_points !== null) {
      const v = Number(dto.loyalty_points);
      if (!Number.isFinite(v) || v < 0 || v > 1_000_000) {
        throw new BadRequestException('loyalty_points debe ser entero >= 0');
      }
    }
  }
}
