/**
 * FIX de deploy — recrea `analytics.mv_wincaja_sales_daily` en su forma **ENRIQUECIDA**.
 *
 * Por qué existe (y no basta con 20260901160000): esa migración se editó EN EL MISMO ARCHIVO de raw
 * → enriquecido DESPUÉS de haberse aplicado como *raw* en prod. Knex trackea las migraciones por
 * NOMBRE, así que una vez registrada `20260901160000` no vuelve a correr aunque cambie su contenido →
 * la forma enriquecida nunca llegó a prod → el fast-path de sellOut tiraba `42703 column
 * vl.branch_name does not exist`. Lección: NUNCA editar una migración ya aplicada; agregar una nueva.
 * Esta, con nombre nuevo, corre en todos los entornos y deja el matview enriquecido idempotentemente.
 *
 * Contenido idéntico al `up` enriquecido de 20260901160000 (grano día, all-history, con vendedor/
 * unidad(CJA)/canal/almacén/marca/etiquetas horneados). Ver esa migración para el detalle y la
 * verificación de dinero (matview == live, al centavo y celda por celda). `WITH NO DATA` → lo puebla
 * el primer refresh (cron 06:20 MX o el botón "Refresh"). El código de sellOut solo usa el fast-path
 * si el matview tiene la columna `branch_name` (blindaje), así que entre la migración y el refresh
 * cae al fallback sin romper.
 *
 * Idempotente: DROP IF EXISTS + CREATE.
 * @param { import("knex").Knex } knex
 */

const CHANNEL_EXPR = `CASE vl.sale_channel WHEN 'mayoreo_credito' THEN 'credito' WHEN 'preventa_vecinal' THEN 'preventa' WHEN 'ruta_venta' THEN 'ruta' ELSE 'mostrador' END`;
const WH_EXPR = `CASE WHEN vl.source_branch = '10' THEN '01' WHEN vl.source_branch = '42' THEN '02' WHEN vl.source_branch = '50' THEN '06' ELSE vl.warehouse_code END`;
const VENDOR_CODE_EXPR = `(vl.source_branch || ':' || vl.vendedor)`;
const VENDOR_NAME_EXPR = `COALESCE(ven.nombre, vl.vendedor)`;
const UNIT_KIND_EXPR = `CASE WHEN am.uv = 'KGS' THEN 'weight' ELSE 'piece' END`;
const UNITS_EXPR = `SUM(CASE WHEN am.uv = 'CJA' THEN vl.qty * COALESCE(NULLIF(am.factor_venta, 0), 1) ELSE vl.qty END)`;

async function createEnriched(knex) {
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
       WHERE vl.business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY vl.tenant_id, vl.business_date, vl.source_branch, vl.wincaja_only, w.code, w.name,
                p.id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre, b.code, p.is_promo,
                (p.deleted_at IS NOT NULL), lp.box_size,
                ${CHANNEL_EXPR}, ${VENDOR_CODE_EXPR}, ${VENDOR_NAME_EXPR}, ${UNIT_KIND_EXPR}
      WITH NO DATA
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_wincaja_sales_daily ON analytics.mv_wincaja_sales_daily
    (tenant_id, business_date, source_branch, warehouse_code, product_id, channel, vendor_code, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_brand ON analytics.mv_wincaja_sales_daily (tenant_id, brand_id, business_date)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_wincaja_sales_daily TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_wincaja_sales_daily IS
    'PERF/RLS: venta WINCAJA a grano día, TODO EL HISTÓRICO, ENRIQUECIDA (vendedor/unidad/canal/almacén/marca/etiquetas horneados al refrescar), sin RLS. El path wincaja de sellOut la lee en trx como un group-by por índice sin joins (~0 ms server-side). Refresh NIGHTLY + ANALYZE. Dinero idéntico al live (verificado al centavo y celda por celda).'`);
}

exports.up = async function (knex) {
  await createEnriched(knex);
};

exports.down = async function (knex) {
  // No revertir a raw: la forma enriquecida es la canónica. Solo dejar limpio si se baja.
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wincaja_sales_daily CASCADE`);
};
