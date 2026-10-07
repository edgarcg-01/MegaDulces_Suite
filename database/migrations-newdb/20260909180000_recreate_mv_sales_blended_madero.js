/**
 * RECREA `analytics.mv_sales_blended` — colateral-dropeada por un CASCADE, + dedup Madero '07'.
 *
 * INCIDENTE (encontrado 2026-09-09 investigando el ítem 2 de la capa): `mv_sales_blended` es la fuente
 * de los KPIs `network*` del Command Center (`commercial-analytics.service` la lee en 3 lugares), con el
 * MISMO schema que `sales_daily`. La migración `20260908120000_sellout_vecinal_channel` hace
 * `DROP MATERIALIZED VIEW analytics.mv_kepler_sales_daily CASCADE` para recrear la cadena del sell-out,
 * y como `mv_sales_blended` CUELGA de `mv_kepler_sales_daily`, el CASCADE **la tiró también** — y esa
 * migración sólo recreó la cadena del sell-out (vista + rollup), NO el blend. Resultado: el objeto
 * desapareció de prod (batch 263 lo creó, un CASCADE de batch 328 lo mató) y los KPIs del Command Center
 * leen una relación inexistente. Es un BLOQUEANTE del deploy: el código que la lee ya está commiteado.
 *
 * ⚠️ RECURRENCIA: cualquier `DROP mv_kepler_sales_daily CASCADE` futuro la vuelve a matar. Se agrega un
 * sensor `mv_sales_blended` a db-health (misma entrega) para que la próxima vez el tablero grite en vez
 * de que el Command Center se rompa en silencio. El fix de fondo (que quien recree mv_kepler recree el
 * blend) queda como disciplina de autoría de migraciones.
 *
 * Cuerpo VERBATIM de `20260903130000_v_sales_blended` (createMv) + DOS cambios de dedup Madero (cutover E,
 * 2026-09-08), idénticos a los de `v_sellout_daily` (mig 20260909170000):
 *   - pierna KEPLER += `OR (source_branch='07' AND business_date >= '2026-09-08')`
 *   - pierna WINCAJA += `AND NOT (source_branch='32' AND business_date >= '2026-09-08')` (acota el wincaja_only de 32)
 * Sin esto, Madero quedaría con hueco desde el 09-08 (32 fuera / 07 ausente) igual que en el sell-out.
 *
 * `WITH NO DATA` → la migración deja la estructura + índices; el REFRESH (pesado, UNION de 3 fuentes) se
 * corre aparte (y el nightly lo mantiene). Idempotente: guard por existencia. @param { import("knex").Knex } knex
 */
async function createMv(knex) {
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
          -- (1) KEPLER sucursales (matview del ODS, dedup complemento del blend wincaja) + Madero '07'
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
               OR (k.source_branch = '07' AND k.business_date >= DATE '2026-09-08')
               OR k.source_branch IN ('03', '04', '05'))
          UNION ALL
          -- (2) RUTAS NUMERADAS (aún fuera del ODS): sales_daily RUTA-% post-cutover
          SELECT sd.tenant_id, sd.product_id, sd.warehouse_id, sd.channel, sd.sale_date, sd.unit_kind,
                 sd.units, sd.revenue, sd.cost, sd.tickets, sd.updated_at
            FROM analytics.sales_daily sd
            JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           WHERE sd.channel NOT LIKE 'wincaja_%' AND w.code LIKE 'RUTA-%' AND sd.sale_date >= DATE '2026-07-01'
          UNION ALL
          -- (3) WINCAJA (matview enriquecido, blend wincaja) — Madero '32' acotado a < 09-08 (cutover a Kepler '07')
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
             AND NOT (mw.source_branch = '32' AND mw.business_date >= DATE '2026-09-08')
        ) q
       GROUP BY tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind
      WITH NO DATA
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_sales_blended ON analytics.mv_sales_blended
    (tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_date ON analytics.mv_sales_blended (tenant_id, sale_date)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_channel ON analytics.mv_sales_blended (tenant_id, channel, sale_date)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_cover ON analytics.mv_sales_blended
    (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sales_blended TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sales_blended IS
    'PARIDAD/ODS: venta real consolidada Kepler(mv_kepler)+rutas(sales_daily RUTA-%)+Wincaja(mv_wincaja), mismo schema que sales_daily. Fuente de los KPIs network del Command Center. ⚠️ CUELGA de mv_kepler_sales_daily: un DROP...CASCADE de ese matview la mata (pasó 2026-09-08). Incluye dedup Madero 07>=09-08 / 32<09-08. Refresh nightly.'`);
}

exports.up = async function (knex) {
  const has = (await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='mv_sales_blended' AND n.nspname='analytics' AND c.relkind='m'`,
  )).rows.length;
  if (has) { console.log('  mv_sales_blended ya existe — skip (idempotente).'); return; }
  await createMv(knex);
  console.log('  mv_sales_blended recreada (WITH NO DATA) + 4 índices. Falta REFRESH (aparte).');
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_blended CASCADE`);
};
