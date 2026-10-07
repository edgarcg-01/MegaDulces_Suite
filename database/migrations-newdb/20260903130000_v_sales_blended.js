/**
 * `analytics.mv_sales_blended` — la venta real CONSOLIDADA (Kepler + Wincaja) MATERIALIZADA, con el
 * mismo schema que `analytics.sales_daily`, para que los KPIs del Command Center (network y historical)
 * cambien sólo el `FROM` en vez de reescribir 10 queries. PARIDAD 1:1 + regla #1 (del ODS, no de la copia).
 *
 * MATERIALIZADA (no vista simple) por costo (§19): el UNION de las 3 fuentes con sus joins da >90s en
 * vivo (la pierna de rutas escanea sales_daily sin índice por warehouse). Refrescada NIGHTLY (con los
 * otros matviews) queda plana e indexada -> los KPIs la leen en ~ms. No inventa dato: deriva de matviews
 * ya refrescados del ODS + la venta-push de rutas.
 *
 * Tres piernas DISJUNTAS (verificado: sin doble-conteo), colapsadas al grano
 * (tenant, producto, almacén, canal, día, unit_kind) — los KPIs agrupan y suman, el vendedor no aplica:
 *   (1) KEPLER sucursales <- mv_kepler_sales_daily, dedup = COMPLEMENTO EXACTO del blend wincaja.
 *   (2) RUTAS NUMERADAS <- sales_daily SÓLO RUTA-% y >=2026-07-01 (aún fuera del ODS; venta-push externo).
 *   (3) WINCAJA <- mv_wincaja_sales_daily, blend wincaja.
 *
 * Canal alineado a sales_daily: Kepler mostrador->'tienda', mayoreo(telemarketing)->'credito' (NO 'mayoreo'
 * = TRASPASO en sales_daily; el matview no trae traspaso). Wincaja->'wincaja_*'. Costo Kepler =
 * revenue/(1+markup) igual que import-sales-fact (cero regresión de margen; costo real por peldaño =
 * MR/ADR-051 pendiente). Tickets sólo en la pierna de rutas (los matviews no cuentan folio).
 *
 * Idempotente: guard por existencia (no dropea si ya está poblada). `WITH NO DATA` -> primer refresh.
 * @param { import("knex").Knex } knex
 */

async function createMv(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_sales_blended`); // por si quedó la vista simple del intento previo
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_blended CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sales_blended AS
      SELECT tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind,
             SUM(units)   AS units,
             SUM(revenue) AS revenue,
             SUM(cost)    AS cost,
             SUM(tickets) AS tickets,
             MAX(updated_at) AS updated_at
        FROM (
          -- (1) KEPLER sucursales (matview del ODS, dedup complemento del blend wincaja)
          SELECT k.tenant_id, k.product_id, w.id AS warehouse_id,
                 CASE k.channel WHEN 'mostrador' THEN 'tienda' WHEN 'mayoreo' THEN 'credito' ELSE k.channel END AS channel,
                 k.business_date AS sale_date, k.unit_kind,
                 k.units, k.monto AS revenue,
                 round(k.monto / (1 + COALESCE(p.markup_pct, 0) / 100.0), 2) AS cost,
                 0 AS tickets, k.business_date::timestamptz AS updated_at
            FROM analytics.mv_kepler_sales_daily k
            JOIN commercial.warehouses w ON w.tenant_id = k.tenant_id AND w.code = k.warehouse_code AND w.deleted_at IS NULL
            LEFT JOIN catalog.products p ON p.id = k.product_id
           WHERE k.product_deleted = false
             AND ((k.source_branch = '01' AND k.business_date >= DATE '2026-07-01')
               OR (k.source_branch = '02' AND k.business_date >= DATE '2025-10-01')
               OR (k.source_branch = '06' AND k.business_date >= DATE '2026-08-15')
               OR k.source_branch IN ('03', '04', '05'))
          UNION ALL
          -- (2) RUTAS NUMERADAS (aún fuera del ODS): sales_daily RUTA-% post-cutover
          SELECT sd.tenant_id, sd.product_id, sd.warehouse_id, sd.channel, sd.sale_date, sd.unit_kind,
                 sd.units, sd.revenue, sd.cost, sd.tickets, sd.updated_at
            FROM analytics.sales_daily sd
            JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           WHERE sd.channel NOT LIKE 'wincaja_%' AND w.code LIKE 'RUTA-%' AND sd.sale_date >= DATE '2026-07-01'
          UNION ALL
          -- (3) WINCAJA (matview enriquecido, blend wincaja)
          SELECT mw.tenant_id, mw.product_id, w.id AS warehouse_id,
                 'wincaja_' || mw.channel AS channel,
                 mw.business_date AS sale_date, mw.unit_kind,
                 mw.units, mw.monto AS revenue, mw.costo AS cost,
                 0 AS tickets, mw.business_date::timestamptz AS updated_at
            FROM analytics.mv_wincaja_sales_daily mw
            JOIN commercial.warehouses w ON w.tenant_id = mw.tenant_id AND w.code = mw.warehouse_code AND w.deleted_at IS NULL
           WHERE mw.product_deleted = false
             AND (mw.wincaja_only = true
               OR (mw.source_branch = '10' AND mw.business_date < DATE '2026-07-01')
               OR (mw.source_branch = '42' AND mw.business_date < DATE '2025-10-01')
               OR (mw.source_branch = '50' AND mw.business_date < DATE '2026-08-15'))
        ) q
       GROUP BY tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind
      WITH NO DATA
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_sales_blended ON analytics.mv_sales_blended
    (tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_date ON analytics.mv_sales_blended (tenant_id, sale_date)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_channel ON analytics.mv_sales_blended (tenant_id, channel, sale_date)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sales_blended TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sales_blended IS
    'PARIDAD/ODS: venta real consolidada Kepler(mv_kepler)+rutas(sales_daily RUTA-%)+Wincaja(mv_wincaja), mismo schema que sales_daily, dedup sin doble-conteo, grano dia x producto x almacen x canal x unit_kind. Fuente de los KPIs del Command Center. Costo kepler=revenue/(1+markup) (MR/ADR-051 pendiente); tickets solo en rutas. Refresh nightly.'`);
}

exports.up = async function (knex) {
  const has = (await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='mv_sales_blended' AND n.nspname='analytics' AND c.relkind='m'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='revenue' AND NOT a.attisdropped)`,
  )).rows.length;
  if (has) return;
  await createMv(knex);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_blended CASCADE`);
};
