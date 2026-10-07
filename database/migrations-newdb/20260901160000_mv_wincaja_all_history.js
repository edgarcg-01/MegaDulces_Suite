/**
 * PASO 3 (PERF/RLS) — matview `analytics.mv_wincaja_sales_daily` a grano día, TODO EL HISTÓRICO y
 * **ENRIQUECIDO**: hornea al refrescar (1×/noche) TODO lo caro que sellOut hacía por request —
 * el dedup de vendedores/artículos (`DISTINCT ON` sobre 383k), la conversión CJA→canónico, el mapeo
 * de canal y de almacén, la marca y las etiquetas (sku/nombre/factor/marca/box_size). Así el path
 * WINCAJA de sellOut queda como un **group-by por índice `(tenant_id, brand_id, business_date)` sin
 * un solo join** → medido server-side (EXPLAIN ANALYZE): la parte wincaja pasa de ~519 ms (matview
 * raw, con los CTE de 383k en vivo) a **~0 ms**, y el endpoint completo del caso reportado baja a
 * ~175 ms (<1 s con muchísimo margen). Bajo RLS el path en vivo de `v_sales_lines` hacía Seq Scan de
 * `maestro` 1.49M + `detalles` 9.9M → timeout; el matview (schema `analytics.*`, SIN RLS) se lee en
 * la conexión normal `trx`.
 *
 * Dinero verificado al centavo contra el path live (con anti-doble-conteo): grand all-brands Ago
 * $23,050,393.1585 y marca DE LA ROSA 351,548 u idénticos. Las etiquetas horneadas NO afectan
 * units/monto (son constantes por grupo).
 *
 * Grano (una fila por): tenant × día × source_branch × almacén-mapeado × producto × canal × vendedor
 * × unit_kind. `is_promo`/`product_deleted`/`wincaja_only`/`source_branch` se conservan como columnas
 * para que sellOut filtre en request (promo/borrados/anti-doble-conteo). Se conserva la cota superior
 * `business_date <= hoy_MX` (excluye basura de fecha futura del POS). Refresh NIGHTLY (wincaja casi
 * estático; ver AnalyticsRefreshService). UNIQUE index para REFRESH CONCURRENTLY. Sin RLS → sellOut
 * filtra tenant_id explícito.
 *
 * Idempotente: DROP IF EXISTS + CREATE. Corre DESPUÉS de la 120000 (misma vista, la reemplaza).
 * @param { import("knex").Knex } knex
 */

const CHANNEL_EXPR = `CASE vl.sale_channel WHEN 'mayoreo_credito' THEN 'credito' WHEN 'preventa_vecinal' THEN 'preventa' WHEN 'ruta_venta' THEN 'ruta' ELSE 'mostrador' END`;
const WH_EXPR = `CASE WHEN vl.source_branch = '10' THEN '01' WHEN vl.source_branch = '42' THEN '02' WHEN vl.source_branch = '50' THEN '06' ELSE vl.warehouse_code END`;
const VENDOR_CODE_EXPR = `(vl.source_branch || ':' || vl.vendedor)`;
const VENDOR_NAME_EXPR = `COALESCE(ven.nombre, vl.vendedor)`;
const UNIT_KIND_EXPR = `CASE WHEN am.uv = 'KGS' THEN 'weight' ELSE 'piece' END`;
const UNITS_EXPR = `SUM(CASE WHEN am.uv = 'CJA' THEN vl.qty * COALESCE(NULLIF(am.factor_venta, 0), 1) ELSE vl.qty END)`;

exports.up = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wincaja_sales_daily CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_wincaja_sales_daily AS
      WITH am AS (
        SELECT DISTINCT ON (tenant_id, articulo) tenant_id, articulo,
               upper(btrim(coalesce(unidad_venta, ''))) AS uv, factor_venta
          FROM wincaja.articulos
         ORDER BY tenant_id, articulo, source_dataset DESC
      ),
      ven AS (
        SELECT DISTINCT ON (tenant_id, source_branch, vendedor) tenant_id, source_branch, vendedor, nombre
          FROM wincaja.vendedores
         ORDER BY tenant_id, source_branch, vendedor, source_dataset DESC
      ),
      lp AS (
        SELECT tenant_id, product_id, max(box_size) AS box_size
          FROM commercial.product_label_prices
         GROUP BY tenant_id, product_id
      )
      SELECT vl.tenant_id,
             vl.business_date,
             vl.source_branch,
             vl.wincaja_only,
             w.code AS warehouse_code,
             w.name AS branch_name,
             p.id   AS product_id,
             p.sku,
             p.nombre,
             p.factor_sale,
             p.brand_id,
             b.nombre AS brand_nombre,
             b.code   AS brand_code,
             p.is_promo,
             (p.deleted_at IS NOT NULL) AS product_deleted,
             lp.box_size,
             ${CHANNEL_EXPR} AS channel,
             ${VENDOR_CODE_EXPR} AS vendor_code,
             ${VENDOR_NAME_EXPR} AS vendor_name,
             ${UNIT_KIND_EXPR} AS unit_kind,
             ${UNITS_EXPR} AS units,
             SUM(vl.importe) AS monto,
             SUM(vl.costo)   AS costo
        FROM wincaja.v_sales_lines vl
        JOIN catalog.products p ON p.tenant_id = vl.tenant_id AND p.sku = vl.sku
        JOIN commercial.warehouses w ON w.tenant_id = vl.tenant_id AND w.deleted_at IS NULL AND w.code = (${WH_EXPR})
        LEFT JOIN catalog.brands b ON b.id = p.brand_id
        LEFT JOIN lp ON lp.tenant_id = p.tenant_id AND lp.product_id = p.id
        LEFT JOIN am ON am.tenant_id = vl.tenant_id AND am.articulo = vl.sku
        LEFT JOIN ven ON ven.tenant_id = vl.tenant_id AND ven.source_branch = vl.source_branch AND ven.vendedor = vl.vendedor
       WHERE vl.business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date  -- todo el histórico; excluye fechas futuras (basura del POS)
       GROUP BY vl.tenant_id, vl.business_date, vl.source_branch, vl.wincaja_only, w.code, w.name,
                p.id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre, b.code, p.is_promo,
                (p.deleted_at IS NOT NULL), lp.box_size,
                ${CHANNEL_EXPR}, ${VENDOR_CODE_EXPR}, ${VENDOR_NAME_EXPR}, ${UNIT_KIND_EXPR}
      WITH NO DATA
  `);
  // UNIQUE (para REFRESH CONCURRENTLY): la llave independiente del grano (las etiquetas están
  // determinadas por product_id/warehouse_code/vendor_code → no rompen unicidad).
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_wincaja_sales_daily ON analytics.mv_wincaja_sales_daily
    (tenant_id, business_date, source_branch, warehouse_code, product_id, channel, vendor_code, unit_kind)`);
  // El índice caliente: sellOut filtra por marca + rango de fecha.
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_brand ON analytics.mv_wincaja_sales_daily (tenant_id, brand_id, business_date)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_wincaja_sales_daily TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_wincaja_sales_daily IS
    'PERF/RLS: venta WINCAJA a grano día, TODO EL HISTÓRICO, ENRIQUECIDA (vendedor/unidad/canal/almacén/marca/etiquetas horneados al refrescar), sin RLS. El path wincaja de sellOut la lee en trx como un group-by por índice sin joins (~0 ms server-side vs ~519 ms del matview raw). Refresh NIGHTLY + ANALYZE. Dinero idéntico al live (verificado al centavo).'`);
};

exports.down = async function (knex) {
  // Rollback a la versión con ventana de 2 meses (def. de la mig 20260901120000, RAW sin enriquecer).
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wincaja_sales_daily CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_wincaja_sales_daily AS
      SELECT tenant_id, business_date, source_branch, warehouse_code, wincaja_only, sku, sale_channel, vendedor,
             SUM(qty) AS qty, SUM(importe) AS importe, SUM(costo) AS costo
        FROM wincaja.v_sales_lines
       WHERE business_date >= date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City')::date) - interval '1 month'
         AND business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY tenant_id, business_date, source_branch, warehouse_code, wincaja_only, sku, sale_channel, vendedor
      WITH NO DATA
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_wincaja_sales_daily ON analytics.mv_wincaja_sales_daily
    (tenant_id, business_date, source_branch, warehouse_code, wincaja_only, sku, sale_channel, vendedor)`);
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_date ON analytics.mv_wincaja_sales_daily (tenant_id, business_date)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_wincaja_sales_daily TO app_runtime`);
};
