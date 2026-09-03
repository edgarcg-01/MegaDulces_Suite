/**
 * `analytics.v_sales_blended` — la venta real CONSOLIDADA (Kepler + Wincaja) con el MISMO schema que
 * `analytics.sales_daily`, para que los KPIs del Command Center (network y historical) cambien sólo el
 * `FROM` en vez de reescribir 10 queries. PARIDAD 1:1 + regla #1 (derivar del ODS, no de la copia).
 *
 * Tres piernas DISJUNTAS (verificado: sin doble-conteo):
 *   (1) KEPLER sucursales ← analytics.mv_kepler_sales_daily (matview del ODS), dedup = COMPLEMENTO
 *       EXACTO del blend wincaja. Recupera el telemarketing (que la copia tiraba) + Canindo.
 *   (2) RUTAS NUMERADAS (21-28) ← analytics.sales_daily SÓLO almacenes RUTA-% y >=2026-07-01. AÚN NO
 *       están en kepler_ods (venta-push de un puller externo). El >=jul elimina el solape de junio.
 *   (3) WINCAJA ← analytics.mv_wincaja_sales_daily, blend wincaja (wincaja_only OR pre-cutover 10/42/50).
 *
 * Vocabulario de canal alineado a sales_daily: Kepler mostrador→'tienda', mayoreo(telemarketing)→
 * 'credito' (NO 'mayoreo': ese valor en sales_daily es TRASPASO y lo excluye NON_SALE; el matview NO
 * tiene traspaso —género N excluido— así que el blend no arrastra traspaso). Wincaja→'wincaja_*'.
 *
 * Costo: Kepler = revenue/(1+markup) IGUAL que import-sales-fact (cero regresión de margen; el costo
 * real por peldaño queda para MR/ADR-051, no se dibuja 0). Wincaja/rutas = costo real de su fuente.
 * Tickets: sólo la pierna de rutas los trae (los matviews no cuentan folio) → avg_ticket global es
 * aproximado; los métodos que dependen de tickets se manejan aparte.
 *
 * Idempotente: CREATE OR REPLACE. NO materializa nada (deriva de matviews ya refrescados nightly).
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sales_blended AS
    -- (1) KEPLER sucursales (matview del ODS, dedup complemento del blend wincaja)
    SELECT k.tenant_id, k.product_id, w.id AS warehouse_id,
           CASE k.channel WHEN 'mostrador' THEN 'tienda' WHEN 'mayoreo' THEN 'credito' ELSE k.channel END AS channel,
           k.business_date AS sale_date,
           k.units,
           k.monto AS revenue,
           round(k.monto / (1 + COALESCE(p.markup_pct, 0) / 100.0), 2) AS cost,
           0 AS tickets,
           k.unit_kind,
           k.business_date::timestamptz AS updated_at
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
    SELECT sd.tenant_id, sd.product_id, sd.warehouse_id, sd.channel, sd.sale_date,
           sd.units, sd.revenue, sd.cost, sd.tickets, sd.unit_kind, sd.updated_at
      FROM analytics.sales_daily sd
      JOIN commercial.warehouses w ON w.id = sd.warehouse_id
     WHERE sd.channel NOT LIKE 'wincaja_%' AND w.code LIKE 'RUTA-%' AND sd.sale_date >= DATE '2026-07-01'
    UNION ALL
    -- (3) WINCAJA (matview enriquecido, blend wincaja)
    SELECT mw.tenant_id, mw.product_id, w.id AS warehouse_id,
           'wincaja_' || mw.channel AS channel,
           mw.business_date AS sale_date,
           mw.units,
           mw.monto AS revenue,
           mw.costo AS cost,
           0 AS tickets,
           mw.unit_kind,
           mw.business_date::timestamptz AS updated_at
      FROM analytics.mv_wincaja_sales_daily mw
      JOIN commercial.warehouses w ON w.tenant_id = mw.tenant_id AND w.code = mw.warehouse_code AND w.deleted_at IS NULL
     WHERE mw.product_deleted = false
       AND (mw.wincaja_only = true
         OR (mw.source_branch = '10' AND mw.business_date < DATE '2026-07-01')
         OR (mw.source_branch = '42' AND mw.business_date < DATE '2025-10-01')
         OR (mw.source_branch = '50' AND mw.business_date < DATE '2026-08-15'))
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_sales_blended TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_sales_blended IS
    'PARIDAD/ODS: venta real consolidada Kepler(mv_kepler)+rutas(sales_daily RUTA-%)+Wincaja(mv_wincaja), mismo schema que sales_daily, dedup sin doble-conteo. Fuente para los KPIs del Command Center. Costo kepler = revenue/(1+markup) (MR/ADR-051 pendiente); tickets sólo en la pierna de rutas.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_sales_blended`);
};
