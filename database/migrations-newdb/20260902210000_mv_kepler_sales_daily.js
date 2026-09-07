/**
 * `analytics.mv_kepler_sales_daily` — la venta KEPLER a grano día, DERIVADA DEL ODS (`kepler_ods`),
 * simétrica a `analytics.mv_wincaja_sales_daily`. Sustituye la copia `analytics.sales_daily`
 * (que la alimenta el importer `import-sales-fact.js` desde el mart consolidado on-prem) como fuente
 * del sell-out Kepler.
 *
 * Por qué existe (regla #1 del proyecto — CERO importers, todo del ODS):
 *   - `sales_daily` NO sale del ODS: lee `mart.ventas_enriched` (otra consolidación), **tira el
 *     vendedor `kdm1.c12`** y **sub-cuenta ~$4.46M/mes** (medido Ago 2026: casi todo de la sucursal 06
 *     migrada + residual de rutas/telemarketing en 01). Además fabrica el costo (`revenue/(1+markup)`).
 *   - Este matview deriva 100% de `kepler_ods.kdm1 ⋈ kdm2 ⋈ kduv`, recupera el vendedor real
 *     (Sergio/Cinthia salían en $0 por la copia), usa el importe real de línea (`kdm2.c13`) y el
 *     catálogo de vendedores `kduv` (fresco, normalizado). Verificado peso por peso contra la vista
 *     ancla AX `analytics.erp_sales_invoices` (U/D/8+12) antes de conectarlo.
 *
 * Universo de venta (doctypes `U-D`): 8 = telemarketing (= MAYOREO, decisión de negocio Edgar
 * 2026-09-02), 10 = mostrador, 12 = crédito. Género U/D es VENTA (el traspaso interno es género N).
 *
 * Canal (horneado, mismo vocabulario que el pivote de sell-out):
 *   - vendedor `1V###` o nombre `RUTA VECINAL%`  → `ruta`   (aunque se cobre a crédito/contado; RS.7)
 *   - doctype 8   → `mayoreo`   (telemarketing = mayoreo)
 *   - doctype 12  → `credito`
 *   - doctype 10  → `mostrador`
 *   La ruta se detecta ANTES del doctype (una misma ruta factura en 10 y 12).
 *
 * Unidades: canónicas (piezas o kg). CJA se multiplica por el factor de caja canónico
 * (`analytics.v_product_box_factor`, NUNCA derivar de c84 — regla de unidades). El DINERO no depende
 * de esto (money = SUM(c13)); las unidades quedan marcadas para verificación fina aparte.
 *
 * Excluye: documentos cancelados (`kdm1.c43='C'`), líneas de servicio (`c11='SER'`), cantidad 0,
 * y fechas futuras del POS (cota `business_date <= hoy_MX`).
 *
 * `WITH NO DATA` → lo puebla el primer refresh (cron nightly o botón "Refresh"). El código de sellOut
 * sólo usa el fast-path si el matview existe y está poblado (blindaje), así que entre la migración y
 * el refresh cae al fallback sin romper. Idempotente: guard por columna + DROP/CREATE.
 *
 * @param { import("knex").Knex } knex
 */

const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;

// Join correcto por PK (incluye c5 + btrim(c6)) — CALZA `ix_kdm2_venta_doc` → 1 día ~214ms, 1 mes ~1.4s.
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
const UNIT_KIND_EXPR = `CASE WHEN upper(btrim(l.c11)) IN ('KGS','KG','KILO','KILOS') THEN 'weight' ELSE 'piece' END`;
const UNITS_EXPR = `SUM(CASE
    WHEN upper(btrim(l.c11)) IN ('KGS','KG','KILO','KILOS') THEN ${QTY}
    WHEN upper(btrim(l.c11)) IN ('CJA','CAJA','CJ') THEN ${QTY} * COALESCE(NULLIF(bf.box_factor,0),1)
    ELSE ${QTY} END)`;

async function createMv(knex) {
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
             SUM(${IMP})             AS monto
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
         AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'        -- no canceladas
         AND COALESCE(btrim(l.c11),'') <> 'SER'                 -- no servicio
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
    'REGLA #1/ODS: venta KEPLER a grano día DERIVADA de kepler_ods (kdm1⋈kdm2⋈kduv), all-history, enriquecida (vendedor/canal/almacén/marca/etiquetas horneados al refrescar), sin RLS. Reemplaza la copia sales_daily como fuente del sell-out Kepler: recupera el vendedor c12 (que la copia tira) y los ~4.46M/mes que sub-cuenta. Money = SUM(kdm2.c13), verificado vs ancla AX erp_sales_invoices. Refresh nightly + ANALYZE.'`);
}

exports.up = async function (knex) {
  // Idempotente: si ya existe con la columna `branch_name`, no lo dropees (preserva data poblada).
  const has = (await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='mv_kepler_sales_daily' AND n.nspname='analytics'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='branch_name' AND NOT a.attisdropped)`,
  )).rows.length;
  if (has) return;
  await createMv(knex);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_sales_daily CASCADE`);
};
