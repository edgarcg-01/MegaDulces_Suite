/**
 * `monto_neto` (NETO DE DESCUENTO, con IVA) en la cadena del sell-out —
 *   mv_kepler_sales_daily → v_sellout_daily → mv_sellout_monthly.
 *
 * Por qué (decisión de negocio 2026-09-05, verdad vs factura UD0801): el reporte mostraba la venta
 * BRUTA de línea (`Σ kdm2.c13`, con IVA, ANTES del descuento de cabecera). Se agrega el NETO de descuento.
 *
 * ⭐ FÓRMULA (kdm1-only, SIN re-agregar el documento): el total y el descuento YA viven en la cabecera
 *   `kdm1` (`c16` = total factura con IVA/neto de descuento; `c13` = descuento). El factor neto por
 *   documento es `c16 / (c16 + descuento)` — sale SOLO de la cabecera ya unida (`h`), sin window ni
 *   self-join ni CTE de doc_total. Por eso el refresh de mv_kepler queda en ~35s (una versión previa que
 *   prorrateaba con window/CTE lo llevó a 7-30 min = inviable; ver git). Propiedades:
 *     - factor ≤ 1 SIEMPRE (descuento ≥ 0) → `monto_neto ≤ monto` garantizado, en todos los canales.
 *     - sin descuento (mostrador contado, desc=0) → factor 1 → neto = bruto (no infla; el bug del
 *       ancla-c16 crudo era dividir por Σlíneas, que en U/D/10 no trae IVA → acá NO pasa).
 *     - con descuento (telemarketing U/D/8, línea con IVA) → Σ_doc(imp·c16/(c16+desc)) ≈ Σlíneas−desc
 *       (el neto de descuento real), a ~0.1% del c16 exacto (redondeo IVA/IEPS por documento del ERP,
 *       inevitable a grano producto). Verificado prod: suc-06 Sep-3 telemarketing 249,577.86 → 246,743.22.
 *   monto_neto de KEPLER = `Σ ${IMP} * c16/(c16+desc)`. WINCAJA (`valor_venta` ya neto) y RUTAS
 *   (`sales_daily.revenue` ya neta) → `monto_neto = monto`.
 *
 * Recrea los 3 objetos en cadena (mv_kepler es matview → su DROP CASCADE tira vista y rollup; se recrean
 * en orden). Idempotente: guard por la columna `monto_neto` en mv_kepler. Refresca mv_kepler (rápido) y
 * deja el rollup `WITH NO DATA` (lo puebla el refresh nocturno/botón). NO editar una vez aplicada.
 * @param { import("knex").Knex } knex
 */

const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;

// ── VERBATIM de 20260902210000_mv_kepler_sales_daily.js (si tocás allá, tocá acá) ──
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
const C16 = `round(COALESCE(NULLIF(regexp_replace(h.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const DESC = `round(COALESCE(NULLIF(regexp_replace(h.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const UNIT_KIND_EXPR = `CASE WHEN upper(btrim(l.c11)) IN ('KGS','KG','KILO','KILOS') THEN 'weight' ELSE 'piece' END`;
const UNITS_EXPR = `SUM(CASE
    WHEN upper(btrim(l.c11)) IN ('KGS','KG','KILO','KILOS') THEN ${QTY}
    WHEN upper(btrim(l.c11)) IN ('CJA','CAJA','CJ') THEN ${QTY} * COALESCE(NULLIF(bf.box_factor,0),1)
    ELSE ${QTY} END)`;
// NETO = bruto × factor de cabecera c16/(c16+desc). Factor por-documento, SIN agregar líneas.
const MONTO_NETO_EXPR = `SUM(${IMP} * ${C16} / NULLIF(${C16} + ${DESC}, 0))`;

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
    'REGLA #1/ODS: venta KEPLER a grano día DERIVADA de kepler_ods (kdm1⋈kdm2⋈kduv), all-history, enriquecida. monto=Σ kdm2.c13 (bruto c/IVA); monto_neto=Σ imp·c16/(c16+desc) (NETO de descuento por factor de cabecera, sin re-agregar doc → refresh 35s). Money verificado vs ancla AX erp_sales_invoices. Refresh nightly + ANALYZE.'`);
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
  await knex.raw(`REFRESH MATERIALIZED VIEW analytics.mv_kepler_sales_daily`);
  await knex.raw(`ANALYZE analytics.mv_kepler_sales_daily`);
};

exports.down = async function () {
  throw new Error('irreversible: monto_neto forma parte de la cadena sell-out; revertir = re-aplicar 20260902210000/20260904100000/20260904100100.');
};
