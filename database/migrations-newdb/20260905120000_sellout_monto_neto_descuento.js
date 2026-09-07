/**
 * `monto_neto` (NETO DE DESCUENTO, con IVA) a lo largo de la cadena del sell-out —
 *   mv_kepler_sales_daily → v_sellout_daily → mv_sellout_monthly.
 *
 * Por qué (decisión de negocio 2026-09-05, verdad absoluta vs factura UD0801): el reporte mostraba
 * la venta BRUTA de línea (`Σ kdm2.c13`, con IVA, ANTES del descuento de cabecera). Se agrega el NETO
 * de descuento (con IVA). Verificado en prod: suc-06 Sep-3 telemarketing bruto $249,577.86 vs neto
 * $246,747.42 (Δ 1.2% = descuento) — la factura c16 marca $246,521.19; el Δ 0.1% neto-vs-c16 es el
 * redondeo IVA/IEPS que el ERP hace por documento (inevitable a grano producto).
 *
 * Definición de `monto_neto` = BRUTO − descuento de cabecera prorrateado:
 *   - KEPLER: Σ_línea( c13_línea × (1 − desc_hdr_doc / Σc13_doc) ) = bruto − descuento del documento
 *     repartido por peso de importe. ⚠️ NO se ancla en `c16`: eso conflaciona descuento con IVA — la
 *     línea `c13` trae IVA en U/D/8 (telemarketing) pero NO en U/D/10 (mostrador), así que `c16`
 *     inflaba mostrador (neto > bruto, medido en .245). Restar el descuento respeta la base de IVA que
 *     ya tenga la línea → `monto_neto ≤ monto` SIEMPRE, en todos los canales. `desc_hdr`/`doc_total`
 *     salen del CTE `doct` (por documento, sobre TODAS las líneas calificadas, no sólo in-catálogo).
 *   - WINCAJA: `valor_venta` del POS YA viene neto (descuento agregado 0.05%, muchos son el código
 *     '2.00') → `monto_neto = monto`.
 *   - RUTAS: `sales_daily.revenue` es POS/venta ya neta → `monto_neto = monto`.
 *
 * Recrea los 3 objetos en cadena (mv_kepler es matview → su DROP CASCADE tira la vista y el rollup;
 * hay que recrearlos en orden). Idempotente: guard por la columna `monto_neto` en mv_kepler. Deja el
 * rollup `WITH NO DATA` (lo puebla el refresh nocturno/botón) y refresca mv_kepler para no dejar hueco.
 *
 * ⚠️ Money-path + re-materialización de matview de PROD → aplicar en ventana coordinada (durante el
 * DROP/CREATE el reporte cae al fallback de la vista). NO editar esta migración una vez aplicada.
 * @param { import("knex").Knex } knex
 */

const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;

// ── constantes VERBATIM de 20260902210000_mv_kepler_sales_daily.js (si tocás allá, tocá acá) ──
const JOIN = `btrim(l.sucursal)=btrim(h.sucursal) AND btrim(l.c1)=btrim(h.c1) AND l.c2=h.c2 AND l.c3=h.c3
  AND l.c4::int=h.c4::int AND l.c5::int=h.c5::int AND btrim(l.c6)=btrim(h.c6)`;
const IS_ROUTE = `(btrim(v.c3) ILIKE 'RUTA %' OR btrim(v.c3) ILIKE 'RUTA VECINAL%' OR btrim(h.c12) ~ '^1V')`;
const CHANNEL_EXPR = `CASE
    WHEN ${IS_ROUTE} THEN 'ruta'
    WHEN h.c4::int = 8  THEN 'mayoreo'
    WHEN h.c4::int = 12 THEN 'credito'
    ELSE 'mostrador' END`;
const VENDOR_CODE_EXPR = `(btrim(h.sucursal) || ':' || btrim(h.c12))`;
const VENDOR_NAME_EXPR = `COALESCE(NULLIF(btrim(v.c3),''), NULLIF(btrim(h.c12),''), 'Sin vendedor')`;
const QTY = `abs(COALESCE(l.c9::numeric,0))`;
const IMP = `round(COALESCE(NULLIF(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const DESC = `round(COALESCE(NULLIF(regexp_replace(h.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2)`; // descuento de cabecera (kdm1.c13)
const UNIT_KIND_EXPR = `CASE WHEN upper(btrim(l.c11)) IN ('KGS','KG','KILO','KILOS') THEN 'weight' ELSE 'piece' END`;
const UNITS_EXPR = `SUM(CASE
    WHEN upper(btrim(l.c11)) IN ('KGS','KG','KILO','KILOS') THEN ${QTY}
    WHEN upper(btrim(l.c11)) IN ('CJA','CAJA','CJ') THEN ${QTY} * COALESCE(NULLIF(bf.box_factor,0),1)
    ELSE ${QTY} END)`;
// NETO = BRUTO − descuento de cabecera prorrateado por peso de importe de línea. NO se ancla en c16:
// eso conflaciona descuento con IVA (la línea c13 trae IVA en U/D/8 pero NO en U/D/10 → c16 inflaría
// mostrador). Restar el descuento respeta la base de IVA que ya tenga la línea → siempre ≤ bruto.
const MONTO_NETO_EXPR = `SUM(${IMP} * (1 - LEAST(COALESCE(dt.desc_hdr,0), dt.doc_total) / NULLIF(dt.doc_total, 0)))`;

// dedup complemento (VERBATIM de v_sellout_daily / service)
const KEPLER_DEDUP = `((k.source_branch='01' AND k.business_date >= DATE '2026-07-01')
      OR (k.source_branch='02' AND k.business_date >= DATE '2025-10-01')
      OR (k.source_branch='06' AND k.business_date >= DATE '2026-08-15')
      OR k.source_branch IN ('03','04','05'))`;
const WINCAJA_DEDUP = `(vl.wincaja_only = true OR (vl.source_branch = '10' AND vl.business_date < DATE '2026-07-01') OR (vl.source_branch = '42' AND vl.business_date < DATE '2025-10-01') OR (vl.source_branch = '50' AND vl.business_date < DATE '2026-08-15'))`;

async function createKepler(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_sales_daily CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_kepler_sales_daily AS
      WITH lp AS (
        SELECT tenant_id, product_id, max(box_size) AS box_size
          FROM commercial.product_label_prices
         GROUP BY tenant_id, product_id
      ),
      -- total de importe de línea + descuento de cabecera POR DOCUMENTO (todas las líneas calificadas),
      -- para prorratear el descuento a cada línea. desc_hdr es constante por documento (MAX = ese valor).
      doct AS (
        SELECT btrim(h.sucursal) AS suc, btrim(h.c1) AS c1, h.c4::int AS c4, h.c5::int AS c5, btrim(h.c6) AS c6,
               SUM(${IMP}) AS doc_total, MAX(${DESC}) AS desc_hdr
          FROM kepler_ods.kdm1 h
          JOIN kepler_ods.kdm2 l ON ${JOIN}
         WHERE h.c2='U' AND h.c3='D' AND h.c4::int IN (8,10,12)
           AND btrim(h.c1)=btrim(h.sucursal)
           AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
           AND COALESCE(btrim(l.c11),'') <> 'SER'
           AND ${QTY} > 0
         GROUP BY 1,2,3,4,5
      )
      SELECT ${T} AS tenant_id,
             h.c9::date              AS business_date,
             btrim(h.sucursal)       AS source_branch,
             w.code                  AS warehouse_code,
             w.name                  AS branch_name,
             p.id                    AS product_id,
             p.sku,
             p.nombre,
             p.factor_sale,
             p.brand_id,
             b.nombre                AS brand_nombre,
             b.code                  AS brand_code,
             p.is_promo,
             (p.deleted_at IS NOT NULL) AS product_deleted,
             lp.box_size,
             ${CHANNEL_EXPR}         AS channel,
             ${VENDOR_CODE_EXPR}     AS vendor_code,
             ${VENDOR_NAME_EXPR}     AS vendor_name,
             ${UNIT_KIND_EXPR}       AS unit_kind,
             ${UNITS_EXPR}           AS units,
             SUM(${IMP})             AS monto,
             ${MONTO_NETO_EXPR}      AS monto_neto
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON ${JOIN}
        JOIN doct dt ON dt.suc=btrim(h.sucursal) AND dt.c1=btrim(h.c1) AND dt.c4=h.c4::int AND dt.c5=h.c5::int AND dt.c6=btrim(h.c6)
        LEFT JOIN kepler_ods.kduv v ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2)=btrim(h.c12)
        JOIN catalog.products p ON p.tenant_id = ${T} AND btrim(p.sku::text) = btrim(l.c8) AND p.deleted_at IS NULL
        JOIN commercial.warehouses w ON w.tenant_id = ${T} AND w.deleted_at IS NULL AND w.code = btrim(h.sucursal)
        LEFT JOIN catalog.brands b ON b.id = p.brand_id
        LEFT JOIN lp ON lp.tenant_id = p.tenant_id AND lp.product_id = p.id
        LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id = ${T} AND bf.product_id = p.id
       WHERE h.c2='U' AND h.c3='D' AND h.c4::int IN (8,10,12)
         AND btrim(h.c1)=btrim(h.sucursal)
         AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
         AND COALESCE(btrim(l.c11),'') <> 'SER'
         AND ${QTY} > 0
         AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY h.c9::date, btrim(h.sucursal), w.code, w.name,
                p.id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre, b.code, p.is_promo,
                (p.deleted_at IS NOT NULL), lp.box_size,
                ${CHANNEL_EXPR}, ${VENDOR_CODE_EXPR}, ${VENDOR_NAME_EXPR}, ${UNIT_KIND_EXPR}
      WITH NO DATA
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_kepler_sales_daily ON analytics.mv_kepler_sales_daily
    (tenant_id, business_date, source_branch, warehouse_code, product_id, channel, vendor_code, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_kepler_daily_brand ON analytics.mv_kepler_sales_daily (tenant_id, brand_id, business_date)`);
  await knex.raw(`CREATE INDEX ix_mv_kepler_daily_date ON analytics.mv_kepler_sales_daily (tenant_id, business_date)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_kepler_sales_daily TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_sales_daily IS
    'REGLA #1/ODS: venta KEPLER a grano día DERIVADA de kepler_ods (kdm1⋈kdm2⋈kduv), all-history, enriquecida. monto=Σ kdm2.c13 (bruto c/IVA); monto_neto=bruto − descuento de cabecera prorrateado (NETO de descuento, ≈ total factura c16). Money verificado vs ancla AX erp_sales_invoices. Refresh nightly + ANALYZE.'`);
}

async function createView(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sellout_daily AS
      WITH lp AS (
        SELECT tenant_id, product_id, max(box_size) AS box_size
          FROM commercial.product_label_prices
         GROUP BY tenant_id, product_id
      )
      SELECT k.tenant_id, k.business_date, k.source_branch, k.warehouse_code, k.branch_name,
             k.product_id, k.sku, k.nombre, k.factor_sale, k.brand_id, k.brand_nombre, k.brand_code,
             k.is_promo, k.box_size,
             CASE k.channel WHEN 'mayoreo' THEN 'credito' ELSE k.channel END AS channel,
             'kepler'::text AS source,
             COALESCE(NULLIF(btrim(k.vendor_code), ''), '')            AS vendor_code,
             COALESCE(NULLIF(btrim(k.vendor_name), ''), 'Sin vendedor') AS vendor_name,
             k.unit_kind, k.units, k.monto, k.monto_neto
        FROM analytics.mv_kepler_sales_daily k
       WHERE k.product_deleted = false
         AND ${KEPLER_DEDUP}
      UNION ALL
      SELECT vl.tenant_id, vl.business_date, vl.source_branch, vl.warehouse_code, vl.branch_name,
             vl.product_id, vl.sku, vl.nombre, vl.factor_sale, vl.brand_id, vl.brand_nombre, vl.brand_code,
             vl.is_promo, vl.box_size,
             vl.channel AS channel,
             'wincaja'::text AS source,
             COALESCE(NULLIF(btrim(vl.vendor_code), ''), '')            AS vendor_code,
             COALESCE(NULLIF(btrim(vl.vendor_name), ''), 'Sin vendedor') AS vendor_name,
             vl.unit_kind, vl.units, vl.monto, vl.monto AS monto_neto
        FROM analytics.mv_wincaja_sales_daily vl
       WHERE vl.product_deleted = false
         AND ${WINCAJA_DEDUP}
      UNION ALL
      SELECT sd.tenant_id, sd.sale_date AS business_date, ''::text AS source_branch,
             w.code AS warehouse_code, w.name AS branch_name,
             sd.product_id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre AS brand_nombre, b.code AS brand_code,
             p.is_promo, lp.box_size,
             'ruta'::text AS channel, 'kepler'::text AS source,
             ''::text AS vendor_code, 'Sin vendedor'::text AS vendor_name,
             sd.unit_kind, sd.units, sd.revenue AS monto, sd.revenue AS monto_neto
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
}

async function createRollup(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sellout_monthly CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sellout_monthly AS
      SELECT tenant_id,
             to_char(business_date, 'YYYY-MM') AS year_month,
             source_branch, warehouse_code, branch_name, product_id, sku, nombre, factor_sale,
             brand_id, brand_nombre, brand_code, is_promo, box_size, channel, source,
             vendor_code, vendor_name, unit_kind,
             SUM(units) AS units,
             SUM(monto) AS monto,
             SUM(monto_neto) AS monto_neto
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
  await knex.raw(`CREATE INDEX ix_mv_sellout_monthly_cover ON analytics.mv_sellout_monthly
    (tenant_id, year_month) INCLUDE (warehouse_code, product_id, channel, source, vendor_code, unit_kind, units, monto, monto_neto)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sellout_monthly TO app_runtime`);
}

exports.up = async function (knex) {
  const has = (await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='mv_kepler_sales_daily' AND n.nspname='analytics'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='monto_neto' AND NOT a.attisdropped)`,
  )).rows.length;
  if (has) return;
  await createKepler(knex);   // DROP CASCADE tira vista + rollup → se recrean abajo
  await createView(knex);
  await createRollup(knex);
  // poblar mv_kepler para no dejar hueco; el rollup lo llena el refresh nocturno/botón (WITH NO DATA).
  await knex.raw(`REFRESH MATERIALIZED VIEW analytics.mv_kepler_sales_daily`);
  await knex.raw(`ANALYZE analytics.mv_kepler_sales_daily`);
};

exports.down = async function (knex) {
  // vuelve a la forma sin monto_neto NO es trivial (recrearía las 3 defs viejas); se deja el forward-only.
  throw new Error('irreversible: monto_neto forma parte de la cadena sell-out; para revertir, re-aplicar las migs base 20260902210000/20260904100000/20260904100100.');
};
