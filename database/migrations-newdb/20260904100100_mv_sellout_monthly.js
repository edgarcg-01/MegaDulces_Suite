/**
 * `analytics.mv_sellout_monthly` — rollup MENSUAL del universo sell-out, la fuente de VELOCIDAD para
 * rangos empresariales (mes-alineados, año completo).
 *
 * Por qué existe: el rango que tiró el 500 (`from=2026-01-01&to=2026-12-31`) fallaba `isMonthAligned`
 * (incluye el mes en curso) → las piernas Kepler+rutas iban a grano DÍA sobre un año → ~70s. El rollup
 * mensual colapsa el eje tiempo (~20-30× menos filas por producto/mes) → los meses cerrados resuelven
 * sub-segundo. El borde parcial/actual del rango lo sirve `analytics.v_sellout_daily` en vivo (pocos
 * días → rápido). El resolvedor de fuente del service parte el rango: meses enteros y cerrados → este
 * matview; borde → la vista.
 *
 * Se define **DESDE `analytics.v_sellout_daily`** (no re-declara las 3 piernas) → la paridad
 * mensual-vs-borde es ESTRUCTURAL (mismo origen): `SUM(mv WHERE year_month=M)` == `SUM(vista en M)` al
 * peso, por construcción. Frescura NOCTURNA (decisión Edgar 2026-09-03): refresh en el cron 06:20 MX,
 * DESPUÉS de mv_kepler + mv_wincaja (de los que deriva vía la vista).
 *
 * Grano: (tenant, year_month, source_branch, warehouse_code, branch_name, product, +attrs, channel,
 * source, vendor, unit_kind) + SUM(units)/SUM(monto). El índice único va sobre el SUBSET
 * (tenant, year_month, source_branch, warehouse_code, product_id, channel, source, vendor_code,
 * unit_kind) — único tras el GROUP BY porque el resto de columnas son dependientes funcionales
 * (branch_name←warehouse_code, sku/marca/box_size←product_id, vendor_name←vendor_code) y sin NULLs
 * (COALESCE en la vista) → habilita REFRESH CONCURRENTLY.
 *
 * `WITH NO DATA` → lo puebla el primer refresh (cron o botón "Refresh"). El service sólo usa el
 * fast-path mensual si el matview está poblado (blindaje); si no, cae a la vista (correcto, más lento).
 * Idempotente: guard por columna `year_month` (patrón mv_kepler/mv_wincaja) — si ya existe poblado, no
 * lo dropea. @param { import("knex").Knex } knex
 */

async function createMv(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sellout_monthly CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sellout_monthly AS
      SELECT tenant_id,
             to_char(business_date, 'YYYY-MM') AS year_month,
             source_branch, warehouse_code, branch_name, product_id, sku, nombre, factor_sale,
             brand_id, brand_nombre, brand_code, is_promo, box_size, channel, source,
             vendor_code, vendor_name, unit_kind,
             SUM(units) AS units,
             SUM(monto) AS monto
        FROM analytics.v_sellout_daily
       GROUP BY tenant_id, to_char(business_date, 'YYYY-MM'),
                source_branch, warehouse_code, branch_name, product_id, sku, nombre, factor_sale,
                brand_id, brand_nombre, brand_code, is_promo, box_size, channel, source,
                vendor_code, vendor_name, unit_kind
      WITH NO DATA
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_sellout_monthly ON analytics.mv_sellout_monthly
    (tenant_id, year_month, source_branch, warehouse_code, product_id, channel, source, vendor_code, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_sellout_monthly_ym ON analytics.mv_sellout_monthly (tenant_id, year_month)`);
  await knex.raw(`CREATE INDEX ix_mv_sellout_monthly_brand ON analytics.mv_sellout_monthly (tenant_id, brand_id, year_month)`);
  // COVERING — la agregación del pivote (GROUP BY grain + SUM) se vuelve casi index-only: full-year
  // all-empresas ~1.9s → ~0.9s (medido). Sólo columnas angostas en INCLUDE (las de texto ancho —
  // sku/nombre/marca — siguen en heap para el max(), costo menor). Patrón de ix_mv_sales_blended_cover.
  await knex.raw(`CREATE INDEX ix_mv_sellout_monthly_cover ON analytics.mv_sellout_monthly
    (tenant_id, year_month) INCLUDE (warehouse_code, product_id, channel, source, vendor_code, unit_kind, units, monto)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sellout_monthly TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sellout_monthly IS
    'SELL-OUT/VELOCIDAD: rollup MENSUAL del universo sell-out, materializado DESDE analytics.v_sellout_daily (paridad estructural con el borde diario). Fuente de los meses cerrados del reporte y sus filtros; el borde parcial/actual va a la vista. Refresh NIGHTLY 06:20 MX tras mv_kepler+mv_wincaja + ANALYZE.'`);
}

exports.up = async function (knex) {
  // Idempotente: si ya existe con la columna `year_month`, no lo dropees (preserva data poblada).
  const has = (await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='mv_sellout_monthly' AND n.nspname='analytics'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='year_month' AND NOT a.attisdropped)`,
  )).rows.length;
  if (has) return;
  await createMv(knex);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sellout_monthly CASCADE`);
};
