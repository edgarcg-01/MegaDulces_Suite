/**
 * `analytics.v_sellout_daily` — DEFINICIÓN ÚNICA del universo del reporte Sell-Out, a grano día.
 *
 * Por qué existe (Fase sintonía+velocidad del sell-out): hasta ahora el pivote `sellOut()` y sus
 * árboles de filtro (`sellOutCanales`/`sellOutVendors`/`sellOutWarehouses`) leían FUENTES DISTINTAS,
 * sin unificar, con dedup distinto → los filtros mostraban hojas que daban $0 en el pivote (y
 * viceversa). Esta vista es el ÚNICO lugar donde se define "qué es una fila de venta del sell-out":
 * el pivote y TODOS los filtros derivan de acá (directo, para el borde parcial/actual; vía el rollup
 * `analytics.mv_sellout_monthly` que se materializa DESDE esta misma vista, para meses cerrados). Así
 * la sintonía filtros↔datos es ESTRUCTURAL, no un test optimista.
 *
 * 3 piernas disjuntas (UNION ALL), con el dedup de cutover y el vocabulario de canal HORNEADOS:
 *   - kepler  = `analytics.mv_kepler_sales_daily` (del ODS), dedup KEPLER_SELLOUT_DEDUP, canal
 *               `mayoreo→credito` (resto passthrough), source='kepler'.
 *   - wincaja = `analytics.mv_wincaja_sales_daily`, dedup blend Wincaja (COMPLEMENTO EXACTO del de
 *               kepler: PH<jul / La Piedad<oct / Canindo<ago15, o wincaja_only), canal passthrough,
 *               source='wincaja'.
 *   - rutas   = las RUTAS NUMERADAS (RUTA-NN, aún fuera del ODS — venta-push de un puller externo a
 *               `analytics.sales_daily`), `>= 2026-07-01`, canal='ruta', source='kepler', sin vendedor.
 * Vocabulario de canal unificado: {mostrador, ruta, credito, preventa}.
 *
 * Dedup = COMPLEMENTO EXACTO entre kepler y wincaja (branch map 10↔01, 42↔02, 50↔06; 03/04/05
 * Kepler-native) → cero doble-conteo en el mes de cutover. Los dos literales se re-declaran acá
 * VERBATIM desde el service (KEPLER_SELLOUT_DEDUP L3454 + el blend wincaja L3009); un test de
 * regresión asegura que empatan (si divergen, alguien tocó uno solo).
 *
 * vendor_code/vendor_name con COALESCE a ''/'Sin vendedor' (las rutas no traen vendedor) → el índice
 * único del rollup mensual queda sin NULLs (para REFRESH CONCURRENTLY) y '' es falsy en JS (el pivote
 * lo trata como "sin vendedor" igual que hoy; el crédito real siempre trae `sucursal:c12`, nunca '').
 *
 * NO se agrega por pierna: el remap de canal puede colisionar grano (p.ej. doc 8 y 12 del mismo
 * vendedor/día → ambos 'credito'); tanto el rollup mensual (GROUP BY) como el pivote en Node
 * re-agregan por clave de columna, así que los duplicados de grano se suman bien. `units` quedan
 * crudas + `unit_kind` (las cajas se calculan por almacén×producto en Node — ADR-055, NO hornear).
 *
 * Idempotente: CREATE OR REPLACE VIEW (misma forma de columnas → sin 0A000 aunque el rollup ya cuelgue
 * de ella). @param { import("knex").Knex } knex
 */

// VERBATIM del service — si tocás uno, tocá el otro (test de paridad lo verifica).
const KEPLER_DEDUP = `((k.source_branch='01' AND k.business_date >= DATE '2026-07-01')
      OR (k.source_branch='02' AND k.business_date >= DATE '2025-10-01')
      OR (k.source_branch='06' AND k.business_date >= DATE '2026-08-15')
      OR k.source_branch IN ('03','04','05'))`;
const WINCAJA_DEDUP = `(vl.wincaja_only = true OR (vl.source_branch = '10' AND vl.business_date < DATE '2026-07-01') OR (vl.source_branch = '42' AND vl.business_date < DATE '2025-10-01') OR (vl.source_branch = '50' AND vl.business_date < DATE '2026-08-15'))`;

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sellout_daily AS
      WITH lp AS (
        SELECT tenant_id, product_id, max(box_size) AS box_size
          FROM commercial.product_label_prices
         GROUP BY tenant_id, product_id
      )
      -- (1) KEPLER (del ODS), dedup complemento, canal mayoreo→credito
      SELECT k.tenant_id, k.business_date, k.source_branch, k.warehouse_code, k.branch_name,
             k.product_id, k.sku, k.nombre, k.factor_sale, k.brand_id, k.brand_nombre, k.brand_code,
             k.is_promo, k.box_size,
             CASE k.channel WHEN 'mayoreo' THEN 'credito' ELSE k.channel END AS channel,
             'kepler'::text AS source,
             COALESCE(NULLIF(btrim(k.vendor_code), ''), '')            AS vendor_code,
             COALESCE(NULLIF(btrim(k.vendor_name), ''), 'Sin vendedor') AS vendor_name,
             k.unit_kind, k.units, k.monto
        FROM analytics.mv_kepler_sales_daily k
       WHERE k.product_deleted = false
         AND ${KEPLER_DEDUP}
      UNION ALL
      -- (2) WINCAJA, dedup blend (complemento exacto)
      SELECT vl.tenant_id, vl.business_date, vl.source_branch, vl.warehouse_code, vl.branch_name,
             vl.product_id, vl.sku, vl.nombre, vl.factor_sale, vl.brand_id, vl.brand_nombre, vl.brand_code,
             vl.is_promo, vl.box_size,
             vl.channel AS channel,
             'wincaja'::text AS source,
             COALESCE(NULLIF(btrim(vl.vendor_code), ''), '')            AS vendor_code,
             COALESCE(NULLIF(btrim(vl.vendor_name), ''), 'Sin vendedor') AS vendor_name,
             vl.unit_kind, vl.units, vl.monto
        FROM analytics.mv_wincaja_sales_daily vl
       WHERE vl.product_deleted = false
         AND ${WINCAJA_DEDUP}
      UNION ALL
      -- (3) RUTAS NUMERADAS (aún fuera del ODS) — sales_daily, sólo almacenes RUTA-% y >= cutover
      SELECT sd.tenant_id, sd.sale_date AS business_date, ''::text AS source_branch,
             w.code AS warehouse_code, w.name AS branch_name,
             sd.product_id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre AS brand_nombre, b.code AS brand_code,
             p.is_promo, lp.box_size,
             'ruta'::text AS channel, 'kepler'::text AS source,
             ''::text AS vendor_code, 'Sin vendedor'::text AS vendor_name,
             sd.unit_kind, sd.units, sd.revenue AS monto
        FROM analytics.sales_daily sd
        JOIN commercial.warehouses w ON w.id = sd.warehouse_id
        JOIN catalog.products p ON p.id = sd.product_id
        LEFT JOIN catalog.brands b ON b.id = p.brand_id
        LEFT JOIN lp ON lp.tenant_id = p.tenant_id AND lp.product_id = p.id
       WHERE w.code LIKE 'RUTA-%'
         AND sd.channel NOT LIKE 'wincaja_%'
         AND sd.sale_date >= DATE '2026-07-01'
         AND sd.sale_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_sellout_daily IS
    'SELL-OUT: definición ÚNICA del universo (3 piernas kepler+wincaja+rutas, dedup y canal horneados). El pivote y TODOS los filtros derivan de acá; mv_sellout_monthly se materializa DESDE esta vista → sintonía estructural. Borde parcial/actual se lee en vivo de acá; meses cerrados del rollup.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_sellout_daily CASCADE`);
};
