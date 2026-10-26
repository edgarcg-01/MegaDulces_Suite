'use strict';
/**
 * `[AB.37]` — **El sell-out cuenta cada venta de ruta UNA vez.** Hoy las cuenta dos.
 *
 * `v_sellout_daily` tenía dos tramos de rutas:
 *   · tramo 3: `analytics.sales_daily` en almacenes `RUTA-%` (el importer `import-sales-fact.js`);
 *   · tramo 4: el envío de la camioneta (`route_push_lines`), sólo Canindo 501–505.
 * Y `sales_daily` ya trae la venta de ruta **dos veces**: el importer manda al mismo `RUTA-NN` lo que
 * entra por el Kepler de Padre Hidalgo (almacén `01-00N`) **y** lo que manda la camioneta (`ruta_NN`).
 * Canindo, además, entraba por los dos tramos.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-26) ────────────────────────────────────────
 *  · Ruta 21, septiembre: tramo 3 = $886,556 = Kepler 01 $395,857 + envío $490,698 (al peso).
 *    Las seis rutas de Padre Hidalgo dan 2.00–2.11× desde el 20-ago, cuando Kepler 01 empezó a
 *    guardar sus documentos. Canindo: tramo 3 = tramo 4, exactamente 2.00× desde septiembre.
 *  · De más en el sell-out: ago $2,165,263 · sep $4,474,700 · oct $3,641,608 (al 25).
 *    Jun sin cambio; jul −$6,378 (lo que el importer sumaba de más antes de que arrancara el envío).
 *  · La venta que NO es de ruta no se mueve ni un peso (ejercido con el texto de este archivo).
 *  · ⭐ Por qué el envío y no el ODS: cuando Kepler 01 tiene el día, coincide con el envío al peso;
 *    pero le faltan **27 días enteros** desde el 1-sep (~$476 K) que nunca subieron de la camioneta.
 *    El envío es la única fuente completa — igual que en Canindo. Llevarlo al ODS es D18.
 *
 * Mismas columnas y tipos → `CREATE OR REPLACE`: conserva los GRANT y las 8 dependientes. Las
 * matviews de encima (`mv_sellout_monthly`, `mv_sellout_budget_rollup`, `mv_sellout_channel_monthly`,
 * `mv_sales_entity_src`) toman el cambio en su refresco nocturno. No mueve datos.
 * ⚠️ NO arregla `mv_sales_blended` (margen), que tiene el mismo tramo de `sales_daily`: es `[AB.38]`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_sellout_daily';

/** Tramos 1 (Kepler de sucursal, del ODS) y 2 (Wincaja antes del corte): VERBATIM, no se tocan. */
const COMUN = ` WITH lp AS (
         SELECT v_product_label_prices.tenant_id,
            v_product_label_prices.product_id,
            max(v_product_label_prices.box_size) AS box_size
           FROM commercial.v_product_label_prices
          GROUP BY v_product_label_prices.tenant_id, v_product_label_prices.product_id
        )
 SELECT k.tenant_id,
    k.business_date,
    k.source_branch,
    k.warehouse_code,
    k.branch_name,
    k.product_id,
    k.sku,
    k.nombre,
    k.factor_sale,
    k.brand_id,
    k.brand_nombre,
    k.brand_code,
    k.is_promo,
    k.box_size,
        CASE k.channel
            WHEN 'credito'::text THEN 'contado_nf'::text
            ELSE k.channel
        END AS channel,
    'kepler'::text AS source,
    COALESCE(NULLIF(btrim(k.vendor_code), ''::text), ''::text) AS vendor_code,
    COALESCE(NULLIF(btrim(k.vendor_name), ''::text), 'Sin vendedor'::text) AS vendor_name,
    k.unit_kind,
    k.units,
    k.monto,
    k.monto_neto
   FROM analytics.mv_kepler_sales_daily k
  WHERE k.product_deleted = false AND NOT (k.source_branch = '06'::text AND k.channel = 'ruta'::text) AND (EXISTS ( SELECT 1
           FROM analytics.v_branch_erp_cutover x
          WHERE x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch AND k.business_date >= x.cutover_date))
UNION ALL
 SELECT vl.tenant_id,
    vl.business_date,
    vl.source_branch,
    vl.warehouse_code,
    vl.branch_name,
    vl.product_id,
    vl.sku,
    vl.nombre,
    vl.factor_sale,
    vl.brand_id,
    vl.brand_nombre,
    vl.brand_code,
    vl.is_promo,
    vl.box_size,
    vl.channel,
    'wincaja'::text AS source,
    COALESCE(NULLIF(btrim(vl.vendor_code), ''::text), ''::text) AS vendor_code,
    COALESCE(NULLIF(btrim(vl.vendor_name), ''::text), 'Sin vendedor'::text) AS vendor_name,
    vl.unit_kind,
    vl.units,
    vl.monto,
    vl.monto AS monto_neto
   FROM analytics.mv_wincaja_sales_daily vl
  WHERE vl.product_deleted = false AND (vl.wincaja_only = true OR (EXISTS ( SELECT 1
           FROM analytics.v_branch_erp_cutover x
          WHERE x.tenant_id = vl.tenant_id AND x.wincaja_source_branch = vl.source_branch AND vl.business_date < x.cutover_date)))`;

/** Tramo 3 — el que se va: rutas desde `sales_daily`, que trae cada venta DOS veces. */
const TRAMO3 = `UNION ALL
 SELECT sd.tenant_id,
    sd.sale_date AS business_date,
    ''::text AS source_branch,
    w.code AS warehouse_code,
    w.name AS branch_name,
    sd.product_id,
    p.sku,
    p.nombre,
    p.factor_sale,
    p.brand_id,
    b.nombre AS brand_nombre,
    b.code AS brand_code,
    p.is_promo,
    lp.box_size,
    'ruta'::text AS channel,
    'kepler'::text AS source,
    ''::text AS vendor_code,
    'Sin vendedor'::text AS vendor_name,
    sd.unit_kind,
    sd.units,
    sd.revenue AS monto,
    sd.revenue AS monto_neto
   FROM analytics.sales_daily sd
     JOIN commercial.warehouses w ON w.id = sd.warehouse_id
     JOIN catalog.products p ON p.id = sd.product_id
     LEFT JOIN catalog.brands b ON b.id = p.brand_id
     LEFT JOIN lp ON lp.tenant_id = p.tenant_id AND lp.product_id = p.id
  WHERE w.code::text ~~ 'RUTA-%'::text AND sd.channel !~~ 'wincaja_%'::text AND sd.sale_date >= '2026-07-01'::date AND sd.sale_date <= (now() AT TIME ZONE 'America/Mexico_City'::text)::date`;

/** Tramo 4 — el envío de la camioneta. Sólo cambia su `WHERE`. */
const tramo4 = (WHERE) => `UNION ALL
 SELECT rpl.tenant_id,
    rpl.business_date,
    ''::text AS source_branch,
    w.code AS warehouse_code,
    w.name AS branch_name,
    p.id AS product_id,
    p.sku,
    p.nombre,
    p.factor_sale,
    p.brand_id,
    b.nombre AS brand_nombre,
    b.code AS brand_code,
    p.is_promo,
    lp.box_size,
    'ruta'::text AS channel,
    'kepler'::text AS source,
    ''::text AS vendor_code,
    'Sin vendedor'::text AS vendor_name,
        CASE
            WHEN upper(btrim(rpl.unidad)) = ANY (ARRAY['KGS'::text, 'KG'::text, 'KILO'::text, 'KILOS'::text]) THEN 'weight'::text
            ELSE 'piece'::text
        END AS unit_kind,
    sum(rpl.qty) AS units,
    sum(rpl.importe) AS monto,
    sum(rpl.importe) AS monto_neto
   FROM analytics.route_push_lines rpl
     JOIN commercial.warehouses w ON w.tenant_id = rpl.tenant_id AND w.deleted_at IS NULL AND w.code::text = ('RUTA-'::text || rpl.route_no)
     JOIN catalog.products p ON p.tenant_id = rpl.tenant_id AND btrim(p.sku::text) = btrim(rpl.sku) AND p.deleted_at IS NULL
     LEFT JOIN catalog.brands b ON b.id = p.brand_id
     LEFT JOIN lp ON lp.tenant_id = p.tenant_id AND lp.product_id = p.id
${WHERE}
  GROUP BY rpl.tenant_id, rpl.business_date, w.code, w.name, p.id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre, b.code, p.is_promo, lp.box_size, (
        CASE
            WHEN upper(btrim(rpl.unidad)) = ANY (ARRAY['KGS'::text, 'KG'::text, 'KILO'::text, 'KILOS'::text]) THEN 'weight'::text
            ELSE 'piece'::text
        END)`;

const WHERE_ANTES = `  WHERE (rpl.route_no = ANY (ARRAY['501'::text, '502'::text, '503'::text, '504'::text, '505'::text])) AND rpl.business_date >= '2026-08-13'::date AND rpl.business_date <= (now() AT TIME ZONE 'America/Mexico_City'::text)::date`;

// Toda camioneta que empuja Y tiene almacén `RUTA-<n>` (el JOIN ya lo exige; los vecinales 1V00x no
// lo tienen y no entran). Desde el corte de su plaza a Kepler: Canindo 13-ago (Wincaja cubre hasta
// el 12), las demás 1-jul (la misma fecha en que arrancaba el tramo 3; antes, Wincaja).
const WHERE_DESPUES = `  WHERE rpl.business_date >= CASE WHEN rpl.route_no ~ '^50[0-9]$' THEN '2026-08-13'::date ELSE '2026-07-01'::date END AND rpl.business_date <= (now() AT TIME ZONE 'America/Mexico_City'::text)::date`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // CREATE OR REPLACE: mismas columnas, mismos tipos → conserva los GRANT y las 8 dependientes.
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS
${COMUN}
${tramo4(WHERE_DESPUES)}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS 'Sell-out diario. Rutas = el envío de cada camioneta (route_push_lines), una sola vez. [AB.37] quitó el tramo de sales_daily, que las contaba dos veces.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve el tramo 3 y el WHERE viejo del tramo 4. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS
${COMUN}
${TRAMO3}
${tramo4(WHERE_ANTES)}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS NULL`);
};
