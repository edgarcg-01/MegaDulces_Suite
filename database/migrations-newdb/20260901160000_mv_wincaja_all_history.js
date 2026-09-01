/**
 * PASO 3 (PERF/RLS) — el matview `analytics.mv_wincaja_sales_daily` (mig 20260901120000) tenía una
 * VENTANA de solo 2 meses; fuera de ella sellOut caía al scan en vivo por la conexión admin (pool
 * `{min:0,max:2}`) → contención de pool → 2.6 min por request. Este lo recrea a TODO EL HISTÓRICO
 * (sin la cota inferior) para que sellOut lo lea en la conexión normal (`trx`, sin RLS) para CUALQUIER
 * rango de wincaja — sin pool admin, sin castigo RLS, sin el scan de maestro (1.44M).
 *
 * Wincaja se está apagando (sus bases se movieron de Access a Postgres; histórico estático + solo
 * Morelia 30/32 sigue viva mientras migra a Kepler), así que la data casi no cambia: el refresh pasa
 * a NIGHTLY (ver AnalyticsRefreshService), no cada 15 min.
 *
 * Mismo grano/columnas que la 120000 (crudo de v_sales_lines; sellOut aplica canal/almacén/CJA encima).
 * Se conserva la cota superior `business_date <= hoy_MX` (excluye basura de fecha futura del POS: hay
 * renglones con año 2029). WITH NO DATA (lo puebla el primer refresh; sellOut lo usa si relispopulated).
 * UNIQUE index para CONCURRENTLY. Sin RLS (analytics.*): sellOut filtra tenant_id explícito.
 *
 * Idempotente: DROP ... IF EXISTS + CREATE. Corre DESPUÉS de la 120000 (misma vista, la reemplaza).
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
       WHERE business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date  -- todo el histórico; solo excluye fechas futuras (basura de captura del POS)
       GROUP BY tenant_id, business_date, source_branch, warehouse_code, wincaja_only, sku, sale_channel, vendedor
      WITH NO DATA
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_wincaja_sales_daily ON analytics.mv_wincaja_sales_daily
    (tenant_id, business_date, source_branch, warehouse_code, wincaja_only, sku, sale_channel, vendedor)`);
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_date ON analytics.mv_wincaja_sales_daily (tenant_id, business_date)`);
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_sku ON analytics.mv_wincaja_sales_daily (tenant_id, sku)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_wincaja_sales_daily TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_wincaja_sales_daily IS
    'PERF/RLS: venta WINCAJA pre-agregada a grano día, TODO EL HISTÓRICO, sin RLS, para el path en vivo de sellOut (leído en trx, cualquier rango). Reemplaza el scan de v_sales_lines (maestro 1.44M) que bajo RLS hace Seq Scan → timeout, y el fallback por conexión admin (pool chico → contención). Refresh NIGHTLY (wincaja casi estático) + ANALYZE. Mismos números que el live (verificado al centavo).'`);
};

exports.down = async function (knex) {
  // Vuelve a la versión con ventana de 2 meses (def. de la mig 20260901120000).
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
  await knex.raw(`CREATE INDEX ix_mv_wincaja_daily_sku ON analytics.mv_wincaja_sales_daily (tenant_id, sku)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_wincaja_sales_daily TO app_runtime`);
};
