/**
 * SELL-OUT — unifica las rutas de Canindo con su VERDAD ABSOLUTA (van-push) sin perder nada.
 *
 * Contexto (investigado 2026-09-10 contra prod): las 5 camionetas de Canindo (branch 06) pushean su
 * Kepler local → runner .249 → `analytics.route_push_lines` = venta a bordo COMPLETA (verdad
 * absoluta). Pero ese van-push sólo llegaba a /comercial/ventas-por-ruta, NO al sell-out. El sell-out
 * veía las rutas de Canindo sólo hasta el corte Wincaja (~12-ago) y después NADA — le faltan
 * $1.36M (ago) + $682k (sep). Además, el branch central (md_06) conservó ~$379k de esa venta a bordo
 * (dt=10, c67~500N) que HOY el sell-out cuenta como MOSTRADOR de Canindo → si se agrega el van-push
 * completo sin más, ese $379k se doble-contaría.
 *
 * Solución (unir sin perder la verdad, sin perder el margen):
 *   1. `mv_kepler_sales_daily`: RECLASIFICA la venta a bordo de Canindo (06, c4=10, c67~'^500[1-9]$')
 *      de 'mostrador' → 'ruta'. NO se excluye → el margen (mv_sales_blended) queda ÍNTEGRO; sólo cambia
 *      la etiqueta de canal (que además es más correcta: son rutas, no mostrador).
 *   2. `v_sellout_daily`: (a) EXCLUYE de la pierna Kepler la ruta del branch 06 (source_branch='06'
 *      AND channel='ruta') — su versión incompleta —, y (b) agrega la 4ª pierna con el van-push
 *      COMPLETO desde `route_push_lines` (rutas 501-505, canal 'ruta', almacén RUTA-50N) desde el
 *      corte 13-ago (Wincaja termina 12-ago → sin hueco ni traslape con la pierna wincaja de leg 2,
 *      que corta 06 en <15-ago; el traslape van-push de 11-12 ago son los disparos de $6 de arranque,
 *      cubiertos por Wincaja).
 *
 * Frente ventas-por-ruta = NO se toca: la deuda de procedencia del `GREATEST` ya la resolvió otro dev
 * (mig ...20260909150000, route_monthly_provenance + reconciler + sensor route_provenance), que
 * MANTIENE el puller del branch como cross-check de "push atorado". Retirarlo regresaría ese trabajo.
 *
 * Recrea la cadena mv_kepler → {mv_sales_blended, v_sellout_daily → mv_sellout_monthly} (DROP CASCADE)
 * porque un matview no admite CREATE OR REPLACE. Definiciones VERBATIM del estado vivo 2026-09-10
 * (pg_get_viewdef) — incluían drift no reflejado en las migraciones (case 'preventa' en mv_kepler,
 * legs 07/32). WITH DATA → sin ventana vacía. Idempotente por convención de una-migración.
 * @param { import("knex").Knex } knex
 */
const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;

// ── mv_kepler_sales_daily: CHANNEL con el nuevo case de venta a bordo Canindo (SELECT == GROUP BY) ──
const K_CHANNEL = `
  CASE
    WHEN btrim(v.c3) ~~* 'RUTA VECINAL%' OR btrim(h.c12) ~ '^[0-9]+V[0-9]' THEN 'preventa'
    WHEN btrim(v.c3) ~~* 'RUTA %' OR btrim(v.c3) ~~* 'RUTA VECINAL%' OR btrim(h.c12) ~ '^1V' THEN 'ruta'
    WHEN btrim(h.sucursal) = '06' AND h.c4::integer = 10 AND btrim(h.c67) ~ '^500[1-9]$' THEN 'ruta'
    WHEN h.c4::integer = 8 THEN 'mayoreo'
    WHEN h.c4::integer = 12 THEN 'credito'
    ELSE 'mostrador'
  END`;
const K_VENDOR_CODE = `(btrim(h.sucursal) || ':') || btrim(h.c12)`;
const K_VENDOR_NAME = `COALESCE(NULLIF(btrim(v.c3), ''), NULLIF(btrim(h.c12), ''), 'Sin vendedor')`;
const K_UNIT_KIND = `CASE WHEN upper(btrim(l.c11)) = ANY (ARRAY['KGS','KG','KILO','KILOS']) THEN 'weight' ELSE 'piece' END`;
const K_UNITS = `sum(CASE
    WHEN upper(btrim(l.c11)) = ANY (ARRAY['KGS','KG','KILO','KILOS']) THEN abs(COALESCE(l.c9::numeric, 0))
    WHEN upper(btrim(l.c11)) = ANY (ARRAY['CJA','CAJA','CJ']) THEN abs(COALESCE(l.c9::numeric, 0)) * COALESCE(NULLIF(bf.box_factor, 0), 1)
    ELSE abs(COALESCE(l.c9::numeric, 0)) END)`;
const K_IMP = `round(COALESCE(NULLIF(regexp_replace(l.c13::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2)`;
const K_NETO = `${K_IMP} * round(COALESCE(NULLIF(regexp_replace(h.c16::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2)
    / NULLIF(round(COALESCE(NULLIF(regexp_replace(h.c16::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2)
      + round(COALESCE(NULLIF(regexp_replace(h.c13::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2), 0)`;

async function createKepler(knex) {
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_kepler_sales_daily AS
      WITH lp AS (
        SELECT tenant_id, product_id, max(box_size) AS box_size
          FROM commercial.product_label_prices GROUP BY tenant_id, product_id
      )
      SELECT ${T} AS tenant_id, h.c9::date AS business_date, btrim(h.sucursal) AS source_branch,
             w.code AS warehouse_code, w.name AS branch_name,
             p.id AS product_id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre AS brand_nombre, b.code AS brand_code,
             p.is_promo, (p.deleted_at IS NOT NULL) AS product_deleted, lp.box_size,
             ${K_CHANNEL} AS channel,
             ${K_VENDOR_CODE} AS vendor_code, ${K_VENDOR_NAME} AS vendor_name,
             ${K_UNIT_KIND} AS unit_kind,
             ${K_UNITS} AS units, sum(${K_IMP}) AS monto, sum(${K_NETO}) AS monto_neto
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON btrim(l.sucursal)=btrim(h.sucursal) AND btrim(l.c1)=btrim(h.c1)
          AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4::integer=h.c4::integer AND l.c5::integer=h.c5::integer AND btrim(l.c6)=btrim(h.c6)
        LEFT JOIN kepler_ods.kduv v ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2)=btrim(h.c12)
        JOIN catalog.products p ON p.tenant_id=${T} AND btrim(p.sku::text)=btrim(l.c8) AND p.deleted_at IS NULL
        JOIN commercial.warehouses w ON w.tenant_id=${T} AND w.deleted_at IS NULL AND w.code::text=btrim(h.sucursal)
        LEFT JOIN catalog.brands b ON b.id=p.brand_id
        LEFT JOIN lp ON lp.tenant_id=p.tenant_id AND lp.product_id=p.id
        LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id=${T} AND bf.product_id=p.id
       WHERE h.c2='U' AND h.c3='D' AND (h.c4::integer = ANY (ARRAY[8,10,12])) AND btrim(h.c1)=btrim(h.sucursal)
         AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C' AND COALESCE(btrim(l.c11), '') <> 'SER'
         AND abs(COALESCE(l.c9::numeric, 0)) > 0 AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY (h.c9::date), (btrim(h.sucursal)), w.code, w.name, p.id, p.sku, p.nombre, p.factor_sale,
                p.brand_id, b.nombre, b.code, p.is_promo, (p.deleted_at IS NOT NULL), lp.box_size,
                (${K_CHANNEL}), (${K_VENDOR_CODE}), (${K_VENDOR_NAME}), (${K_UNIT_KIND})
      WITH DATA`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_kepler_sales_daily ON analytics.mv_kepler_sales_daily
    (tenant_id, business_date, source_branch, warehouse_code, product_id, channel, vendor_code, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_kepler_daily_brand ON analytics.mv_kepler_sales_daily (tenant_id, brand_id, business_date)`);
  await knex.raw(`CREATE INDEX ix_mv_kepler_daily_date ON analytics.mv_kepler_sales_daily (tenant_id, business_date)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_kepler_sales_daily TO app_runtime`);
}

async function createBlended(knex) {
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sales_blended AS
      SELECT tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind,
             sum(units) AS units, sum(revenue) AS revenue, sum(cost) AS cost, sum(tickets) AS tickets, max(updated_at) AS updated_at
        FROM (
          SELECT k.tenant_id, k.product_id, w.id AS warehouse_id,
                 CASE k.channel WHEN 'mostrador' THEN 'tienda' WHEN 'mayoreo' THEN 'credito' ELSE k.channel END AS channel,
                 k.business_date AS sale_date, k.unit_kind, k.units, k.monto AS revenue,
                 round(k.monto / (1 + COALESCE(p.markup_pct, 0) / 100.0), 2) AS cost, 0 AS tickets,
                 k.business_date::timestamptz AS updated_at
            FROM analytics.mv_kepler_sales_daily k
            JOIN commercial.warehouses w ON w.tenant_id=k.tenant_id AND w.code::text=k.warehouse_code::text AND w.deleted_at IS NULL
            LEFT JOIN catalog.products p ON p.id=k.product_id
           WHERE k.product_deleted=false
             AND (k.source_branch='01' AND k.business_date >= DATE '2026-07-01'
               OR k.source_branch='02' AND k.business_date >= DATE '2025-10-01'
               OR k.source_branch='06' AND k.business_date >= DATE '2026-08-15'
               OR k.source_branch='07' AND k.business_date >= DATE '2026-09-08'
               OR (k.source_branch = ANY (ARRAY['03','04','05'])))
          UNION ALL
          SELECT sd.tenant_id, sd.product_id, sd.warehouse_id, sd.channel, sd.sale_date, sd.unit_kind,
                 sd.units, sd.revenue, sd.cost, sd.tickets, sd.updated_at
            FROM analytics.sales_daily sd
            JOIN commercial.warehouses w ON w.id=sd.warehouse_id
           WHERE sd.channel NOT LIKE 'wincaja_%' AND w.code::text LIKE 'RUTA-%' AND sd.sale_date >= DATE '2026-07-01'
          UNION ALL
          SELECT mw.tenant_id, mw.product_id, w.id AS warehouse_id, 'wincaja_' || mw.channel AS channel,
                 mw.business_date AS sale_date, mw.unit_kind, mw.units, mw.monto AS revenue, mw.costo AS cost, 0 AS tickets,
                 mw.business_date::timestamptz AS updated_at
            FROM analytics.mv_wincaja_sales_daily mw
            JOIN commercial.warehouses w ON w.tenant_id=mw.tenant_id AND w.code::text=mw.warehouse_code::text AND w.deleted_at IS NULL
           WHERE mw.product_deleted=false
             AND (mw.wincaja_only=true OR mw.source_branch='10' AND mw.business_date < DATE '2026-07-01'
               OR mw.source_branch='42' AND mw.business_date < DATE '2025-10-01'
               OR mw.source_branch='50' AND mw.business_date < DATE '2026-08-15')
             AND NOT (mw.source_branch='32' AND mw.business_date >= DATE '2026-09-08')
        ) q
       GROUP BY tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind
      WITH DATA`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_sales_blended ON analytics.mv_sales_blended (tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_date ON analytics.mv_sales_blended (tenant_id, sale_date)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_channel ON analytics.mv_sales_blended (tenant_id, channel, sale_date)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_cover ON analytics.mv_sales_blended (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sales_blended TO app_runtime`);
}

async function createSelloutDaily(knex) {
  await knex.raw(`
    CREATE VIEW analytics.v_sellout_daily AS
      WITH lp AS (
        SELECT tenant_id, product_id, max(box_size) AS box_size
          FROM commercial.product_label_prices GROUP BY tenant_id, product_id
      )
      -- (1) KEPLER (del ODS) — EXCLUYE la ruta del branch 06 (versión incompleta; la reemplaza el van-push, leg 4)
      SELECT k.tenant_id, k.business_date, k.source_branch, k.warehouse_code, k.branch_name,
             k.product_id, k.sku, k.nombre, k.factor_sale, k.brand_id, k.brand_nombre, k.brand_code,
             k.is_promo, k.box_size,
             CASE k.channel WHEN 'mayoreo' THEN 'credito' ELSE k.channel END AS channel,
             'kepler'::text AS source,
             COALESCE(NULLIF(btrim(k.vendor_code), ''), '') AS vendor_code,
             COALESCE(NULLIF(btrim(k.vendor_name), ''), 'Sin vendedor') AS vendor_name,
             k.unit_kind, k.units, k.monto, k.monto_neto
        FROM analytics.mv_kepler_sales_daily k
       WHERE k.product_deleted = false
         AND NOT (k.source_branch = '06' AND k.channel = 'ruta')
         AND ((k.source_branch = '01' AND k.business_date >= DATE '2026-07-01')
           OR (k.source_branch = '02' AND k.business_date >= DATE '2025-10-01')
           OR (k.source_branch = '06' AND k.business_date >= DATE '2026-08-15')
           OR (k.source_branch = ANY (ARRAY['03','04','05']))
           OR (k.source_branch = '07' AND k.business_date >= DATE '2026-09-08'))
      UNION ALL
      -- (2) WINCAJA (blend)
      SELECT vl.tenant_id, vl.business_date, vl.source_branch, vl.warehouse_code, vl.branch_name,
             vl.product_id, vl.sku, vl.nombre, vl.factor_sale, vl.brand_id, vl.brand_nombre, vl.brand_code,
             vl.is_promo, vl.box_size, vl.channel AS channel, 'wincaja'::text AS source,
             COALESCE(NULLIF(btrim(vl.vendor_code), ''), '') AS vendor_code,
             COALESCE(NULLIF(btrim(vl.vendor_name), ''), 'Sin vendedor') AS vendor_name,
             vl.unit_kind, vl.units, vl.monto, vl.monto AS monto_neto
        FROM analytics.mv_wincaja_sales_daily vl
       WHERE vl.product_deleted = false
         AND (vl.wincaja_only = true
           OR (vl.source_branch = '10' AND vl.business_date < DATE '2026-07-01')
           OR (vl.source_branch = '42' AND vl.business_date < DATE '2025-10-01')
           OR (vl.source_branch = '50' AND vl.business_date < DATE '2026-08-15'))
         AND NOT (vl.source_branch = '32' AND vl.business_date >= DATE '2026-09-08')
      UNION ALL
      -- (3) RUTAS NUMERADAS (push a sales_daily; PH RUTA-2N + histórico)
      SELECT sd.tenant_id, sd.sale_date AS business_date, ''::text AS source_branch,
             w.code AS warehouse_code, w.name AS branch_name,
             sd.product_id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre AS brand_nombre, b.code AS brand_code,
             p.is_promo, lp.box_size, 'ruta'::text AS channel, 'kepler'::text AS source,
             ''::text AS vendor_code, 'Sin vendedor'::text AS vendor_name,
             sd.unit_kind, sd.units, sd.revenue AS monto, sd.revenue AS monto_neto
        FROM analytics.sales_daily sd
        JOIN commercial.warehouses w ON w.id = sd.warehouse_id
        JOIN catalog.products p ON p.id = sd.product_id
        LEFT JOIN catalog.brands b ON b.id = p.brand_id
        LEFT JOIN lp ON lp.tenant_id = p.tenant_id AND lp.product_id = p.id
       WHERE w.code LIKE 'RUTA-%' AND sd.channel NOT LIKE 'wincaja_%'
         AND sd.sale_date >= DATE '2026-07-01'
         AND sd.sale_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
      UNION ALL
      -- (4) VAN-PUSH CANINDO (rutas 501-505 desde sus propias bases, route_push_lines) — verdad completa
      SELECT rpl.tenant_id, rpl.business_date, ''::text AS source_branch,
             w.code AS warehouse_code, w.name AS branch_name,
             p.id AS product_id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre AS brand_nombre, b.code AS brand_code,
             p.is_promo, lp.box_size, 'ruta'::text AS channel, 'kepler'::text AS source,
             ''::text AS vendor_code, 'Sin vendedor'::text AS vendor_name,
             CASE WHEN upper(btrim(rpl.unidad)) IN ('KGS','KG','KILO','KILOS') THEN 'weight' ELSE 'piece' END AS unit_kind,
             sum(rpl.qty)::numeric AS units, sum(rpl.importe)::numeric AS monto, sum(rpl.importe)::numeric AS monto_neto
        FROM analytics.route_push_lines rpl
        JOIN commercial.warehouses w ON w.tenant_id = rpl.tenant_id AND w.deleted_at IS NULL AND w.code = 'RUTA-' || rpl.route_no
        JOIN catalog.products p ON p.tenant_id = rpl.tenant_id AND btrim(p.sku::text) = btrim(rpl.sku) AND p.deleted_at IS NULL
        LEFT JOIN catalog.brands b ON b.id = p.brand_id
        LEFT JOIN lp ON lp.tenant_id = p.tenant_id AND lp.product_id = p.id
       WHERE rpl.route_no IN ('501','502','503','504','505')
         AND rpl.business_date >= DATE '2026-08-13'
         AND rpl.business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY rpl.tenant_id, rpl.business_date, w.code, w.name, p.id, p.sku, p.nombre, p.factor_sale,
                p.brand_id, b.nombre, b.code, p.is_promo, lp.box_size,
                CASE WHEN upper(btrim(rpl.unidad)) IN ('KGS','KG','KILO','KILOS') THEN 'weight' ELSE 'piece' END`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);
}

async function createSelloutMonthly(knex) {
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sellout_monthly AS
      SELECT tenant_id, to_char(business_date::timestamptz, 'YYYY-MM') AS year_month,
             source_branch, warehouse_code, branch_name, product_id, sku, nombre, factor_sale,
             brand_id, brand_nombre, brand_code, is_promo, box_size, channel, source, vendor_code, vendor_name, unit_kind,
             sum(units) AS units, sum(monto) AS monto, sum(monto_neto) AS monto_neto
        FROM analytics.v_sellout_daily
       GROUP BY tenant_id, (to_char(business_date::timestamptz, 'YYYY-MM')), source_branch, warehouse_code,
                branch_name, product_id, sku, nombre, factor_sale, brand_id, brand_nombre, brand_code,
                is_promo, box_size, channel, source, vendor_code, vendor_name, unit_kind
      WITH DATA`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_sellout_monthly ON analytics.mv_sellout_monthly (tenant_id, year_month, source_branch, warehouse_code, product_id, channel, source, vendor_code, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_sellout_monthly_ym ON analytics.mv_sellout_monthly (tenant_id, year_month)`);
  await knex.raw(`CREATE INDEX ix_mv_sellout_monthly_brand ON analytics.mv_sellout_monthly (tenant_id, brand_id, year_month)`);
  await knex.raw(`CREATE INDEX ix_mv_sellout_monthly_cover ON analytics.mv_sellout_monthly (tenant_id, year_month) INCLUDE (warehouse_code, product_id, channel, source, vendor_code, unit_kind, units, monto, monto_neto)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sellout_monthly TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_sales_daily CASCADE`);
  await createKepler(knex);
  await createBlended(knex);
  await createSelloutDaily(knex);
  await createSelloutMonthly(knex);
};

exports.down = async function () {
  // Sin down automático: revertir estas 4 recreaciones a mano es más riesgoso que rehacerlas.
  // Para revertir, recrear las definiciones previas (mostrador sin reclasificar, sin leg 4 van-push).
  throw new Error('irreversible por seguridad: recrear la cadena a mano si hay que revertir (ver git).');
};
