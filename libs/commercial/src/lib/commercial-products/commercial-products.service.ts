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

      // [CAT.6] Ademas del rango, el DESGLOSE por plaza de cada alta: "las 7 sucursales" no
      // contesta la pregunta operativa, que es a que precio sale en CADA una. Se arma con
      // json_agg dentro del mismo GROUP BY, sin una consulta extra por fila.
      const cte = conPrecio
        ? `, pr AS (
             SELECT lp.product_id,
                    min(lp.piece_price) AS precio_min,
                    max(lp.piece_price) AS precio_max,
                    ${porSucursal ? 'count(DISTINCT lp.sucursal)::int' : '1'} AS sucursales,
                    ${porSucursal
                      ? `json_agg(json_build_object('sucursal', w3.name, 'precio', lp.piece_price)
                                  ORDER BY w3.name)`
                      : `'[]'::json`} AS por_sucursal
               FROM commercial.product_label_prices lp
               ${porSucursal
                 ? `JOIN commercial.warehouses w3
                      ON w3.kepler_code = lp.sucursal AND w3.deleted_at IS NULL
                     AND w3.sells_to_public IS TRUE`
                 : ''}
              WHERE lp.piece_price IS NOT NULL AND lp.piece_price > 0
              GROUP BY lp.product_id
           )`
        : `, pr AS (SELECT NULL::uuid AS product_id, NULL::numeric AS precio_min,
                          NULL::numeric AS precio_max, 0::int AS sucursales,
                          '[]'::json AS por_sucursal WHERE false)`;

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
        ), suc AS (
          -- [CAT.4] EN QUE SUCURSAL se repite. catalog.product_barcodes NO tiene plaza (lo dice su
          -- propia migracion de NORM.3), asi que el rastro sale de product_label_prices, que si la
          -- tiene. OJO: esa tabla guarda el codigo de PIEZA, de modo que si el duplicado vive en el
          -- codigo de paquete o de caja, aca no aparece. Medido en prod: de 50 codigos repetidos,
          -- 26 tienen rastro de plaza y 24 no. Los 24 se marcan "no consta" en vez de inventarles
          -- una sucursal o de esconderlos.
          SELECT btrim(lp.barcode) AS barcode,
                 array_agg(DISTINCT w.name ORDER BY w.name) AS sucursales
            FROM commercial.product_label_prices lp
            JOIN commercial.warehouses w
              ON w.kepler_code = lp.sucursal AND w.deleted_at IS NULL AND w.sells_to_public IS TRUE
           WHERE btrim(coalesce(lp.barcode, '')) <> ''
           GROUP BY btrim(lp.barcode), lp.sucursal
          HAVING count(DISTINCT lp.product_id) > 1
        ), suc2 AS (
          SELECT barcode, array_agg(DISTINCT x ORDER BY x) AS sucursales
            FROM suc, unnest(sucursales) AS x
           GROUP BY barcode
        )${cte}
        SELECT d.barcode,
               count(DISTINCT b.sku)::int AS altas,
               json_agg(DISTINCT jsonb_build_object(
                 'sku', b.sku, 'nombre', p.nombre, 'unit', b.unit, 'activo', p.activo,
                 'supplier_name', s.name,
                 'precio_min', pr.precio_min, 'precio_max', pr.precio_max,
                 'sucursales', coalesce(pr.sucursales, 0),
                 'por_sucursal', coalesce(pr.por_sucursal, '[]'::json)
               )) AS productos,
               min(pr.precio_min) AS precio_min,
               max(pr.precio_max) AS precio_max,
               max(sc.sucursales) AS sucursales
          FROM dup d
          JOIN catalog.product_barcodes b
            ON btrim(b.barcode) = d.barcode
           AND b.deleted_at IS NULL AND b.activo IS TRUE AND b.source LIKE 'kepler%'
          LEFT JOIN catalog.products p ON p.sku = b.sku AND p.deleted_at IS NULL
          LEFT JOIN catalog.suppliers s ON s.id = p.supplier_id
          LEFT JOIN pr ON pr.product_id = p.id
          LEFT JOIN suc2 sc ON sc.barcode = d.barcode
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
            // `[]` significa "no consta en que plaza", NO "en ninguna". La pantalla los distingue.
            sucursales: (r.sucursales as string[]) ?? [],
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
   * `[CAT.3]` **Precios distintos** — el mismo producto a distinto precio según la sucursal.
   *
   * El cliente que compra el mismo dulce en 8 Esquinas y en Padre Hidalgo debería pagar lo mismo.
   * Cuando no pasa, casi siempre es que alguien actualizó el precio en una plaza y no se replicó a
   * las demás — no una decisión comercial.
   *
   * ── DE DÓNDE SALE ───────────────────────────────────────────────────────────────────────────
   * `commercial.product_label_prices`, que desde `[NORM.3]` tiene grano **(tenant, producto,
   * sucursal)** y la alimenta el hop-2 desde el ODS en la misma transacción en que las filas
   * aterrizan. O sea: es el precio que la tienda publica, no una copia nuestra ni un promedio.
   *
   * ⚠️ Se usa la TABLA, no `commercial.v_product_label_prices`. La vista existe para los lectores
   * agregados y **elige una sola fila por producto** (moda entre plazas) — justo lo que acá hay
   * que comparar. Consultarla daría 0 diferencias siempre.
   *
   * ── DOS DEFECTOS, NO UNO ────────────────────────────────────────────────────────────────────
   *   `pieza`   — el precio normal difiere entre plazas.
   *   `mayoreo` — el precio normal coincide, pero el de volumen no. Se ve menos y duele igual:
   *               quien se lleva una caja paga distinto según dónde entre.
   * Se reportan por separado porque se corrigen en pantallas distintas de Kepler.
   *
   * No decide cuál precio es "el correcto": eso necesita saber **cuál se actualizó al último**, y
   * esta tabla no guarda esa historia. Acá se muestra la dispersión y en qué plaza está cada
   * extremo; quién manda es trabajo de la fase Red de Precios.
   */
  async priceDiscrepancies(query: {
    search?: string; minPct?: number; kind?: 'pieza' | 'mayoreo' | 'unidad' | ''; limit?: number;
  } = {}) {
    const search = (query.search || '').trim();
    const minPct = Number.isFinite(Number(query.minPct)) ? Math.max(0, Number(query.minPct)) : 0;
    const k = query.kind;
    const kind = k === 'pieza' || k === 'mayoreo' || k === 'unidad' ? k : '';
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);

    return this.tk.run(async (trx) => {
      const chk = await trx.raw(`
        SELECT to_regclass('commercial.product_label_prices') IS NOT NULL AS tabla,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'commercial' AND table_name = 'product_label_prices'
                          AND column_name = 'sucursal') AS por_sucursal`);
      if (chk.rows[0]?.tabla !== true || chk.rows[0]?.por_sucursal !== true) {
        return { total: 0, comparable: false, rows: [] };
      }

      const filtro = search ? `AND (p.nombre ILIKE :q OR p.sku ILIKE :q OR b.barcode ILIKE :q)` : '';
      const filtroKind =
        kind === 'pieza'   ? 'AND a.pieza_pct > 0 AND NOT a.sospecha_unidad'
        : kind === 'mayoreo' ? 'AND a.mayoreo_pct > 0'
        : kind === 'unidad'  ? 'AND a.sospecha_unidad'
        : 'AND NOT a.sospecha_unidad';

      // (Sin acentos graves acá adentro: cierran el template literal de JS. Ya rompió el build
      //  cinco veces en este repo — ver CLAUDE.md.)
      const { rows } = await trx.raw(
        `
        WITH agg AS (
          SELECT lp.product_id,
                 count(DISTINCT lp.sucursal)::int                                          AS sucursales,
                 min(lp.piece_price) FILTER (WHERE lp.piece_price > 0)                     AS pieza_min,
                 max(lp.piece_price) FILTER (WHERE lp.piece_price > 0)                     AS pieza_max,
                 min(lp.wholesale_piece_price) FILTER (WHERE lp.wholesale_piece_price > 0) AS may_min,
                 max(lp.wholesale_piece_price) FILTER (WHERE lp.wholesale_piece_price > 0) AS may_max,
                 (array_agg(w.name ORDER BY lp.piece_price ASC  NULLS LAST)
                    FILTER (WHERE lp.piece_price > 0))[1]                                  AS suc_barata,
                 (array_agg(w.name ORDER BY lp.piece_price DESC NULLS LAST)
                    FILTER (WHERE lp.piece_price > 0))[1]                                  AS suc_cara
            FROM commercial.product_label_prices lp
            -- Solo las plazas que VENDEN AL PUBLICO. El join ademas deja fuera al CEDIS 00
            -- sin hardcodearlo: no esta dado de alta en warehouses, y su precio de pieza es
            -- en realidad el de caja: mezclarlo inventaba diferencias de 9,000 %.
            JOIN commercial.warehouses w
              ON w.kepler_code = lp.sucursal AND w.deleted_at IS NULL AND w.sells_to_public IS TRUE
           GROUP BY lp.product_id
          HAVING count(DISTINCT lp.sucursal) > 1
        ), a AS (
          SELECT agg.*,
                 CASE WHEN pieza_min > 0 THEN (pieza_max - pieza_min) / pieza_min * 100 ELSE 0 END AS pieza_pct,
                 CASE WHEN may_min  > 0 THEN (may_max  - may_min)  / may_min  * 100 ELSE 0 END AS mayoreo_pct,
                 -- ⚠️ Una plaza cobrando 3 veces lo de otra por el MISMO SKU casi nunca es una
                 -- decisión de precio: es que una capturó por pieza y la otra por caja. Se marca
                 -- y se saca de la lista principal, porque si no acapara los primeros lugares y
                 -- entierra las diferencias reales (medido en prod: 58 casos contra 974 reales).
                 -- No se BORRA: se manda a su propia vista, porque también hay que arreglarlo.
                 (pieza_min > 0 AND pieza_max / pieza_min >= 3) AS sospecha_unidad
            FROM agg
        )
        SELECT p.sku, p.nombre, p.activo, b.barcode, s.name AS supplier_name,
               a.sucursales, a.suc_barata, a.suc_cara, a.sospecha_unidad,
               a.pieza_min, a.pieza_max, round(a.pieza_pct::numeric, 2)   AS pieza_pct,
               a.may_min,   a.may_max,   round(a.mayoreo_pct::numeric, 2) AS mayoreo_pct,
               (SELECT json_agg(json_build_object(
                          'sucursal', w2.name, 'pieza', x.piece_price,
                          'mayoreo', x.wholesale_piece_price, 'desde', x.wholesale_piece_min_qty)
                        ORDER BY w2.name)
                  FROM commercial.product_label_prices x
                  JOIN commercial.warehouses w2
                    ON w2.kepler_code = x.sucursal AND w2.deleted_at IS NULL
                   AND w2.sells_to_public IS TRUE
                 WHERE x.product_id = p.id)                                AS por_sucursal
          FROM a
          JOIN catalog.products p ON p.id = a.product_id AND p.deleted_at IS NULL
          LEFT JOIN LATERAL (
            SELECT z.barcode FROM commercial.product_label_prices z
             WHERE z.product_id = p.id AND z.barcode IS NOT NULL LIMIT 1
          ) b ON true
          LEFT JOIN catalog.suppliers s ON s.id = p.supplier_id
         WHERE (a.pieza_pct > 0 OR a.mayoreo_pct > 0)
           AND greatest(a.pieza_pct, a.mayoreo_pct) >= :minpct
           ${filtroKind} ${filtro}
         ORDER BY a.sospecha_unidad, greatest(a.pieza_pct, a.mayoreo_pct) DESC
         LIMIT :lim
        `,
        search ? { q: `%${search}%`, minpct: minPct, lim: limit } : { minpct: minPct, lim: limit },
      );

      const num = (v: unknown) => (v == null ? null : Number(v));
      return {
        total: rows.length,
        comparable: true,
        rows: rows.map((r: Record<string, unknown>) => ({
          sku: String(r.sku),
          nombre: (r.nombre as string) ?? null,
          barcode: (r.barcode as string) ?? null,
          activo: r.activo === true,
          supplier_name: (r.supplier_name as string) ?? null,
          sucursales: Number(r.sucursales),
          suc_barata: (r.suc_barata as string) ?? null,
          suc_cara: (r.suc_cara as string) ?? null,
          sospecha_unidad: r.sospecha_unidad === true,
          pieza_min: num(r.pieza_min), pieza_max: num(r.pieza_max),
          pieza_pct: num(r.pieza_pct) ?? 0,
          mayoreo_min: num(r.may_min), mayoreo_max: num(r.may_max),
          mayoreo_pct: num(r.mayoreo_pct) ?? 0,
          por_sucursal: (r.por_sucursal as unknown[]) ?? [],
        })),
      };
    });
  }

  /**
   * `[CAT.7]` **El latido del catálogo**: ¿cambió algo desde la última vez que miraste?
   *
   * Nace de un reporte real: *"cuando en Kepler arreglan los errores de códigos y de precios, no se
   * actualiza aquí"*. Se midió la ingesta antes de tocar nada y **estaba sana** — cero códigos
   * fantasma (todo lo que publicamos sigue existiendo en Kepler), 4 de 8,761 precios divergentes
   * (0.0 %) y la fuente viva a 18 minutos. Lo que no se actualizaba era **la pantalla**: cargaba al
   * abrirse y se quedaba ahí, así que quien corregía en Kepler y se quedaba mirando la pestaña no
   * veía cambiar nada nunca.
   *
   * Devuelve el instante más reciente de las DOS fuentes que alimentan las tres pestañas. Es una
   * consulta escalar: la pantalla la pide cada pocos segundos y sólo recarga de verdad cuando el
   * valor se movió.
   *
   * Medido contra producción: **24.8 ms** (tres `max()` por seq scan sobre 12.5k + 69.8k + 11.2k
   * filas). A un pulso cada 10 s no justifica un índice —que además sería una migración— pero si
   * `product_label_prices` crece un orden de magnitud, ahí sí conviene uno sobre `updated_at`.
   *
   * ⚠️ Los dos UPSERT de origen son **churn-free** (sólo tocan la fila si el dato cambió), así que
   * este instante se mueve cuando de verdad cambió un precio o un código — no cada vez que el
   * replicador vuelve a pasar. Eso es lo que lo hace un latido honesto y no un reloj.
   */
  async catalogHeartbeat() {
    return this.tk.run(async (trx) => {
      const r = await trx.raw(`
        SELECT greatest(
                 coalesce((SELECT max(updated_at) FROM catalog.product_barcodes), 'epoch'::timestamptz),
                 coalesce((SELECT max(updated_at) FROM commercial.product_label_prices), 'epoch'::timestamptz),
                 coalesce((SELECT max(updated_at) FROM catalog.products WHERE deleted_at IS NULL), 'epoch'::timestamptz)
               ) AS latido`);
      const t = r.rows[0]?.latido;
      return {
        // `null` = ninguna fuente tiene fecha. La pantalla lo declara en vez de fingir que está al día.
        latido: t ? new Date(t).toISOString() : null,
        servidor_at: new Date().toISOString(),
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
