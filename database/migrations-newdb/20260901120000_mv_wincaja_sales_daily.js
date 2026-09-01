/**
 * PASO 2 (PERF/RLS) — Sell-Out lee la parte WINCAJA de la vista `wincaja.v_sales_lines` (deriva
 * de `maestro_mov_almacen` 1.44M + detalles + conc_dates 350k). Bajo RLS (app_runtime) la barrera
 * de seguridad impide empujar el predicado de fecha al índice de maestro → Seq Scan → timeout 45s.
 * El paso 1 (leer por la conexión admin sin RLS) lo bajó a ~3s. Este matview lo lleva a
 * sub-segundo (verificado en prod bajo app_runtime: 915ms).
 *
 * Gemelo del `analytics.sales_daily` de Kepler: pre-agrega la venta wincaja a grano DÍA en
 * `analytics.*` (que por diseño NO tiene RLS → sellOut la lee en su propia conexión, rápido).
 * VENTANA MÓVIL = mes en curso + mes anterior (cubre "este mes" y parciales recientes; rangos
 * más viejos caen al fallback admin del paso 1). Meses COMPLETOS ya usan `sales_by_vendor_monthly`.
 *
 * Semántica IDÉNTICA al live (verificado units/monto al centavo): agrega las columnas CRUDAS de
 * v_sales_lines (qty/importe/costo) por (día, sucursal, almacén, sku, canal, vendedor); sellOut
 * aplica encima sus mapeos (canal/almacén/CJA) sobre la SUMA — algebraicamente igual (los factores
 * son escalares por sku/sucursal). El anti-doble-conteo concentrada/actual ya viene baked en
 * v_sales_lines; el de sucursal-migrada (wincaja_only/business_date) lo aplica sellOut al leer.
 *
 * WITH NO DATA: la puebla el primer REFRESH del AnalyticsRefreshService (relispopulated=false →
 * refresh normal; luego CONCURRENTLY). sellOut sólo la usa cuando relispopulated=true (sino
 * fallback admin). El refresh hace ANALYZE (grano fino ~99k filas/mes → sin stats el planner
 * elige un plan catastrófico; verificado). UNIQUE index (grano) para CONCURRENTLY. Sin RLS
 * (analytics.*): sellOut filtra tenant_id EXPLÍCITO.
 *
 * Idempotente: DROP ... IF EXISTS + CREATE.
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wincaja_sales_daily CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_wincaja_sales_daily AS
      SELECT tenant_id,
             business_date,
             source_branch,
             warehouse_code,
             wincaja_only,
             sku,
             sale_channel,
             vendedor,
             SUM(qty)     AS qty,
             SUM(importe) AS importe,
             SUM(costo)   AS costo
        FROM wincaja.v_sales_lines
       WHERE business_date >= date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City')::date) - interval '1 month'
         AND business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date  -- excluye fechas futuras (basura de captura del POS: hay renglones con año 2029)
       GROUP BY tenant_id, business_date, source_branch, warehouse_code, wincaja_only, sku, sale_channel, vendedor
      WITH NO DATA
  `);
  // UNIQUE = grano completo (habilita REFRESH CONCURRENTLY). vendedor puede ser NULL: los NULL
  // son distintos en un unique index y el GROUP BY garantiza un solo renglón por combo, así que
  // no hay violación; CONCURRENTLY los maneja (churn menor en renglones sin vendedor, no rompe).
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_wincaja_sales_daily ON analytics.mv_wincaja_sales_daily
    (tenant_id, business_date, source_branch, warehouse_code, wincaja_only, sku, sale_channel, vendedor)`);
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_date ON analytics.mv_wincaja_sales_daily (tenant_id, business_date)`);
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_sku ON analytics.mv_wincaja_sales_daily (tenant_id, sku)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_wincaja_sales_daily TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_wincaja_sales_daily IS
    'PERF/RLS: venta WINCAJA pre-agregada a grano día (ventana móvil: mes actual + anterior) para el path en vivo de sellOut, SIN RLS. Reemplaza el scan de v_sales_lines (maestro 1.44M) que bajo RLS hace Seq Scan → timeout 45s. Refresh 15min + ANALYZE. Mismos números que el live (verificado al centavo). Fuera de ventana → fallback conexión admin.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wincaja_sales_daily CASCADE`);
};
