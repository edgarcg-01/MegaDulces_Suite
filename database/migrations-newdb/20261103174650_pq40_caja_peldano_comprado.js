'use strict';
/**
 * `[PQ.40]` Cuando la ficha de Kepler no dice la caja, la caja es la unidad con la que Kepler COMPRA.
 *
 * El caso que lo abrió: el 18283 AMARANTO TRIANGULO salía «sin valuar» y sin sugerido en
 * /compras/pedido. Su ficha en Kepler (kdii, las 9 sucursales) es PZA×1 / PZA×1 / PZA×1 —sin
 * caja— pero `v_product_box_factor` le ponía **300** por `factor_sale` (un factor de venta del
 * catálogo, no de Kepler). Contra un costo de caja de pieza, el árbitro de peldaño lo marcaba
 * contradicho y lo sacaba del valuado y del pedido. Regla del PM (2026-10-24): misma fórmula que
 * Kepler. Donde la ficha calla, la fórmula de Kepler para una línea nueva es la unidad en la que
 * Kepler realmente compra (`kdm2.c58` de sus X-A-20/X-A-35; PQ.13 midió que la OC lleva el factor
 * de la ficha en 98.61 % cuando la ficha lo trae).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-03) ───────────────────────────────────────
 *  · Dos reglas más simples, REFUTADAS antes de escribir ésta:
 *      - «ficha toda en PZA×1 ⇒ sin caja»: de 54 productos así, 21 se COMPRAN por caja en Kepler
 *        (33220 en CJA×100 = el 100 de la Suite). Les rompería la caja.
 *      - «costo unidad mayor (c4) = costo pieza (c8) ⇒ sin caja»: los 54 tienen c4 = c8, los 21
 *        de caja incluidos. No separa nada.
 *  · Esta regla, ejercida con el cuerpo exacto de abajo contra prod:
 *      - `v_product_box_factor`: 11,352 filas antes y después; cambian **40 productos**, todos a
 *        caja 1 (36 `factor_sale` y 4 `etiquetera` → `kepler_peldano_comprado`). 3.3 s.
 *      - `v_warehouse_box_factor`: cambian **543 celdas** de esos mismos 40, y ninguna otra.
 *      - Los que se compran por caja quedan intactos: compran en DOS peldaños (CJA×10 y PAQ×1) y
 *        la regla exige uno solo.
 *  · Control negativo: de los 40, TODAS sus líneas de compra X-A (cualquier documento, sucursal
 *    o fecha) con factor > 1 → sólo el **40216** (4 líneas KG×10 fuera de la ventana de 365 d; se
 *    vende con peldaño 10). Los otros 39 nunca se compraron en una unidad mayor. Queda declarado:
 *    la regla mira lo que Kepler hace HOY (365 d), igual que el peldaño cobrado.
 *
 * ── Lo que NO hace ────────────────────────────────────────────────────────────────────────
 *  · No le gana al override (`commercial.product_unit_overrides`), ni a `kepler_c84`, ni a la ficha
 *    de la sucursal: entra DESPUÉS de ellos y sólo reemplaza a `etiquetera` y `factor_sale`. Los 31
 *    productos con override de caja > 1 que Kepler compra sólo por pieza quedan como están
 *    (decisión humana explícita; se le listan a Compras).
 *  · No cambia la lista de columnas de ninguna vista: `CREATE OR REPLACE` conserva a los 7
 *    dependientes de `v_product_box_factor` y a los 5 de `v_warehouse_box_factor`.
 *  · `mv_kepler_sales_daily` lee `v_product_box_factor`: las cajas de estos 40 cambian en su
 *    próximo refresco nocturno, no acá.
 *
 * `mv_kepler_bought_rung` es la gemela de `mv_kepler_sold_rung` (KX.5/R.5) del lado de compra:
 * mismo join de 7 columnas, misma ventana, refresco nocturno en AnalyticsRefreshService
 * (`analytics_refresh_bought_rung`). Se materializa por costo (~1 s de agregación) porque
 * `v_product_box_factor` se lee en caliente.
 *
 * ⛔ FUERA de horario hábil: crea una matvista sobre kdm2 y refresca las dos de factor de caja.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const MV = `
  CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_kepler_bought_rung AS
  SELECT btrim(d.c8)                                                      AS sku,
         max(NULLIF(btrim(d.c58::text), '')::numeric)                     AS rung_max,
         mode() WITHIN GROUP (ORDER BY NULLIF(btrim(d.c58::text), '')::numeric) AS rung_modal,
         count(DISTINCT NULLIF(btrim(d.c58::text), '')::numeric)          AS peldanos,
         count(*)                                                         AS renglones,
         min(h.c9)::date                                                  AS primer_visto,
         max(h.c9)::date                                                  AS ultimo_visto
    FROM kepler_ods.kdm2 d
    -- Las SIETE columnas de la PK de kdm1 (R.5: con 5 el join abanica).
    JOIN kepler_ods.kdm1 h
      ON h.sucursal = d.sucursal AND h.c1 = d.c1 AND h.c2 = d.c2 AND h.c3 = d.c3
     AND h.c4 = d.c4 AND h.c5 = d.c5 AND h.c6 = d.c6
   WHERE d.c2 = 'X' AND d.c3 = 'A'
     AND d.c4 IN (20, 35)                       -- entrada y orden de compra
     AND h.c9 >= current_date - 365
     AND d.sucursal = btrim(d.c1)
     AND NULLIF(btrim(d.c58::text), '')::numeric > 0
   GROUP BY 1`;

// Cuerpos armados desde la definición VIVA de prod (pg_get_viewdef) con reemplazos exactos.
const PBF_NUEVA = `
  WITH ladder AS (
           SELECT kdii.c1 AS sku,
              max(NULLIF(btrim(kdii.c11), ''::text)) AS u_base,
              max(kdii.c81) AS f_paq,
              max(kdii.c84) AS f_caja
             FROM kepler_ods.kdii
            WHERE kdii.sucursal <> '00'::text
            GROUP BY kdii.c1
          ), src AS (
           SELECT p.tenant_id,
              p.id AS product_id,
              COALESCE(p.factor_sale, 1)::numeric AS fs,
              lbl.bs::numeric AS etiq,
              kbf.box_factor AS c84,
              uov.box_factor AS ovr,
              l.f_paq,
              l.f_caja,
              br.rung_max AS compra_rung,
              br.peldanos AS compra_peldanos,
                  CASE
                      WHEN upper(l.u_base) ~ '^[A-Z]{2,4}$'::text THEN upper(l.u_base)
                      ELSE NULL::text
                  END AS unit_base
             FROM catalog.products p
               LEFT JOIN ( SELECT v_product_label_prices.tenant_id,
                      v_product_label_prices.product_id,
                      max(v_product_label_prices.box_size) AS bs
                     FROM commercial.v_product_label_prices
                    GROUP BY v_product_label_prices.tenant_id, v_product_label_prices.product_id) lbl ON lbl.tenant_id = p.tenant_id AND lbl.product_id = p.id
               LEFT JOIN analytics.product_box_factor kbf ON kbf.tenant_id = p.tenant_id AND kbf.product_id = p.id
               LEFT JOIN commercial.product_unit_overrides uov ON uov.tenant_id = p.tenant_id AND uov.product_id = p.id AND uov.deleted_at IS NULL
               LEFT JOIN ladder l ON l.sku = p.sku::text
               LEFT JOIN analytics.mv_kepler_bought_rung br ON br.sku = btrim(p.sku::text)
            WHERE p.deleted_at IS NULL
          ), r AS (
           SELECT src.tenant_id,
              src.product_id,
              src.fs,
              src.etiq,
              src.c84,
              src.ovr,
              src.unit_base,
              src.compra_rung,
              COALESCE(src.f_paq, 1::numeric) <= 1::numeric AND COALESCE(src.f_caja, 1::numeric) <= 1::numeric AND src.compra_peldanos = 1 AND src.compra_rung >= 1::numeric AS compra_ok,
              src.fs > 1::numeric AND src.etiq > 1::numeric AND src.fs = src.etiq AS inner_ok,
              GREATEST(
                  CASE
                      WHEN src.fs > 1::numeric THEN src.fs
                      ELSE 1::numeric
                  END,
                  CASE
                      WHEN src.etiq > 1::numeric THEN src.etiq
                      ELSE 1::numeric
                  END) AS inner_box,
              src.unit_base = ANY (ARRAY['KG'::text, 'KGS'::text]) AS is_weight
             FROM src
          ), resolved AS (
           SELECT r.tenant_id,
              r.product_id,
              r.fs,
              r.etiq,
              r.c84,
              r.ovr,
              r.unit_base,
              r.inner_ok,
              r.inner_box,
              r.is_weight,
              GREATEST(COALESCE(
                  CASE
                      WHEN r.ovr IS NOT NULL AND NOT (r.ovr = 1::numeric AND GREATEST(COALESCE(r.c84, 1::numeric), COALESCE(r.etiq, 1::numeric), COALESCE(r.fs, 1::numeric)) > 1::numeric) THEN r.ovr
                      ELSE NULL::numeric
                  END,
                  CASE
                      WHEN r.inner_ok AND r.c84 >= (3::numeric * r.fs) THEN r.fs
                      WHEN r.c84 > 1::numeric THEN r.c84
                      WHEN r.compra_ok AND (r.etiq > 1::numeric OR r.fs > 1::numeric) THEN r.compra_rung
                      WHEN r.etiq > 1::numeric THEN r.etiq
                      WHEN r.fs > 1::numeric THEN r.fs
                      ELSE 1::numeric
                  END), 1::numeric) AS box_factor,
                  CASE
                      WHEN r.ovr IS NOT NULL AND r.ovr = 1::numeric AND GREATEST(COALESCE(r.c84, 1::numeric), COALESCE(r.etiq, 1::numeric), COALESCE(r.fs, 1::numeric)) > 1::numeric THEN 'override_no_dato'::text
                      WHEN r.ovr IS NOT NULL THEN 'override'::text
                      WHEN r.inner_ok AND r.c84 >= (3::numeric * r.fs) THEN 'inner_box_guard'::text
                      WHEN r.c84 > 1::numeric THEN 'kepler_c84'::text
                      WHEN r.compra_ok AND (r.etiq > 1::numeric OR r.fs > 1::numeric) THEN 'kepler_peldano_comprado'::text
                      WHEN r.etiq > 1::numeric THEN 'etiquetera'::text
                      WHEN r.fs > 1::numeric THEN 'factor_sale'::text
                      ELSE 'default'::text
                  END AS source
             FROM r
          )
   SELECT tenant_id,
      product_id,
      COALESCE(c84 > 1::numeric AND inner_box > 1::numeric AND c84 >= (3::numeric * inner_box) OR is_weight AND box_factor > 1::numeric OR box_factor > 1000::numeric OR source = 'factor_sale'::text AND box_factor > 1::numeric, false) AS is_master_suspect,
      box_factor,
      source,
      unit_base,
      is_weight,
          CASE
              WHEN source = ANY (ARRAY['factor_sale'::text, 'inner_box_guard'::text]) THEN 'ambiguous'::text
              WHEN box_factor > 1::numeric THEN 'pieces'::text
              ELSE 'n/a'::text
          END AS factor_unit
     FROM resolved`;

const VBF_NUEVA = `
  WITH wh AS (
           SELECT w.tenant_id,
              w.id,
              w.code,
              w.kepler_code,
              w.wincaja_source_branch
             FROM commercial.warehouses w
            WHERE w.deleted_at IS NULL AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
          ), wcf AS (
           SELECT w.tenant_id,
              w.id AS warehouse_id,
              a.articulo AS sku,
              a.factor_venta AS fv,
              a.unidad_venta AS unidad
             FROM wh w
               JOIN wincaja.articulos a ON a.tenant_id = w.tenant_id AND a.source_branch = w.wincaja_source_branch AND a.source_dataset = 'actual'::text
            WHERE w.kepler_code IS NULL AND (a.factor_venta > 1::numeric OR a.factor_venta = 1::numeric AND btrim(upper(a.unidad_venta)) = 'CJA'::text)
          ), base AS (
           SELECT w.tenant_id,
              w.id AS warehouse_id,
              w.code AS warehouse_code,
              w.kepler_code,
              p.id AS product_id,
              p.sku,
              GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) AS f_previo,
              wcf.fv AS wcf_fv,
              wcf.unidad AS wcf_unidad,
              bfx.source AS bfx_source,
              bfx.is_weight,
              bfx.is_master_suspect,
              sr.rung_max,
              kul.factor_caja AS kul_factor,
              kul.factor_source AS kul_source,
              lad.u3_label AS lad_u3,
              lad.u1_label AS lad_u1
             FROM wh w
               JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
               LEFT JOIN analytics.v_product_box_factor bfx ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
               LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku::text
               LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku::text
               LEFT JOIN analytics.mv_kepler_sold_rung sr ON sr.sucursal = w.kepler_code AND sr.sku = p.sku::text
               LEFT JOIN analytics.v_kepler_unit_ladder kul ON kul.sucursal = w.kepler_code AND kul.sku = btrim(p.sku::text)
          )
   SELECT tenant_id,
      warehouse_id,
      warehouse_code,
      product_id,
      sku,
          CASE
              WHEN kepler_code IS NOT NULL AND kul_factor IS NOT NULL THEN GREATEST(kul_factor, 1::numeric)
              WHEN kepler_code IS NOT NULL AND bfx_source = 'kepler_peldano_comprado'::text THEN f_previo
              WHEN f_previo = 1::numeric AND kepler_code IS NOT NULL AND rung_max > 1::numeric THEN rung_max
              ELSE f_previo
          END AS box_factor,
          CASE
              WHEN kepler_code IS NOT NULL AND kul_factor IS NOT NULL THEN
              CASE kul_source
                  WHEN 'unidad_unica'::text THEN 'kepler_unidad_unica'::text
                  WHEN 'derivado_del_costo'::text THEN 'kepler_ficha_costo'::text
                  WHEN 'capturado_contradice_al_costo'::text THEN 'kepler_ficha_contradice_costo'::text
                  ELSE 'kepler_ficha'::text
              END
              WHEN kepler_code IS NOT NULL AND bfx_source = 'kepler_peldano_comprado'::text THEN 'kepler_peldano_comprado'::text
              WHEN f_previo = 1::numeric AND kepler_code IS NOT NULL AND rung_max > 1::numeric THEN 'kepler_peldano_vendido'::text
              WHEN wcf_fv IS NOT NULL THEN 'wincaja_factor_venta'::text
              ELSE COALESCE(bfx_source, 'none'::text)
          END AS factor_source,
          CASE
              WHEN kepler_code IS NOT NULL THEN 'kepler'::text
              ELSE 'wincaja'::text
          END AS erp,
      lad_u3 AS box_label,
      COALESCE(wcf_unidad, lad_u1) AS base_label,
      COALESCE(is_weight, false) AS is_weight,
      COALESCE(is_master_suspect, false) AS is_master_suspect
     FROM base`;

// Las definiciones previas, tal cual estaban en prod el 2026-11-03: las usa el down.
const PBF_PREVIA = `
  WITH ladder AS (
           SELECT kdii.c1 AS sku,
              max(NULLIF(btrim(kdii.c11), ''::text)) AS u_base,
              max(kdii.c81) AS f_paq,
              max(kdii.c84) AS f_caja
             FROM kepler_ods.kdii
            WHERE kdii.sucursal <> '00'::text
            GROUP BY kdii.c1
          ), src AS (
           SELECT p.tenant_id,
              p.id AS product_id,
              COALESCE(p.factor_sale, 1)::numeric AS fs,
              lbl.bs::numeric AS etiq,
              kbf.box_factor AS c84,
              uov.box_factor AS ovr,
                  CASE
                      WHEN upper(l.u_base) ~ '^[A-Z]{2,4}$'::text THEN upper(l.u_base)
                      ELSE NULL::text
                  END AS unit_base
             FROM catalog.products p
               LEFT JOIN ( SELECT v_product_label_prices.tenant_id,
                      v_product_label_prices.product_id,
                      max(v_product_label_prices.box_size) AS bs
                     FROM commercial.v_product_label_prices
                    GROUP BY v_product_label_prices.tenant_id, v_product_label_prices.product_id) lbl ON lbl.tenant_id = p.tenant_id AND lbl.product_id = p.id
               LEFT JOIN analytics.product_box_factor kbf ON kbf.tenant_id = p.tenant_id AND kbf.product_id = p.id
               LEFT JOIN commercial.product_unit_overrides uov ON uov.tenant_id = p.tenant_id AND uov.product_id = p.id AND uov.deleted_at IS NULL
               LEFT JOIN ladder l ON l.sku = p.sku::text
            WHERE p.deleted_at IS NULL
          ), r AS (
           SELECT src.tenant_id,
              src.product_id,
              src.fs,
              src.etiq,
              src.c84,
              src.ovr,
              src.unit_base,
              src.fs > 1::numeric AND src.etiq > 1::numeric AND src.fs = src.etiq AS inner_ok,
              GREATEST(
                  CASE
                      WHEN src.fs > 1::numeric THEN src.fs
                      ELSE 1::numeric
                  END,
                  CASE
                      WHEN src.etiq > 1::numeric THEN src.etiq
                      ELSE 1::numeric
                  END) AS inner_box,
              src.unit_base = ANY (ARRAY['KG'::text, 'KGS'::text]) AS is_weight
             FROM src
          ), resolved AS (
           SELECT r.tenant_id,
              r.product_id,
              r.fs,
              r.etiq,
              r.c84,
              r.ovr,
              r.unit_base,
              r.inner_ok,
              r.inner_box,
              r.is_weight,
              GREATEST(COALESCE(
                  CASE
                      WHEN r.ovr IS NOT NULL AND NOT (r.ovr = 1::numeric AND GREATEST(COALESCE(r.c84, 1::numeric), COALESCE(r.etiq, 1::numeric), COALESCE(r.fs, 1::numeric)) > 1::numeric) THEN r.ovr
                      ELSE NULL::numeric
                  END,
                  CASE
                      WHEN r.inner_ok AND r.c84 >= (3::numeric * r.fs) THEN r.fs
                      WHEN r.c84 > 1::numeric THEN r.c84
                      WHEN r.etiq > 1::numeric THEN r.etiq
                      WHEN r.fs > 1::numeric THEN r.fs
                      ELSE 1::numeric
                  END), 1::numeric) AS box_factor,
                  CASE
                      WHEN r.ovr IS NOT NULL AND r.ovr = 1::numeric AND GREATEST(COALESCE(r.c84, 1::numeric), COALESCE(r.etiq, 1::numeric), COALESCE(r.fs, 1::numeric)) > 1::numeric THEN 'override_no_dato'::text
                      WHEN r.ovr IS NOT NULL THEN 'override'::text
                      WHEN r.inner_ok AND r.c84 >= (3::numeric * r.fs) THEN 'inner_box_guard'::text
                      WHEN r.c84 > 1::numeric THEN 'kepler_c84'::text
                      WHEN r.etiq > 1::numeric THEN 'etiquetera'::text
                      WHEN r.fs > 1::numeric THEN 'factor_sale'::text
                      ELSE 'default'::text
                  END AS source
             FROM r
          )
   SELECT tenant_id,
      product_id,
      COALESCE(c84 > 1::numeric AND inner_box > 1::numeric AND c84 >= (3::numeric * inner_box) OR is_weight AND box_factor > 1::numeric OR box_factor > 1000::numeric OR source = 'factor_sale'::text AND box_factor > 1::numeric, false) AS is_master_suspect,
      box_factor,
      source,
      unit_base,
      is_weight,
          CASE
              WHEN source = ANY (ARRAY['factor_sale'::text, 'inner_box_guard'::text]) THEN 'ambiguous'::text
              WHEN box_factor > 1::numeric THEN 'pieces'::text
              ELSE 'n/a'::text
          END AS factor_unit
     FROM resolved`;

const VBF_PREVIA = `
  WITH wh AS (
           SELECT w.tenant_id,
              w.id,
              w.code,
              w.kepler_code,
              w.wincaja_source_branch
             FROM commercial.warehouses w
            WHERE w.deleted_at IS NULL AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
          ), wcf AS (
           SELECT w.tenant_id,
              w.id AS warehouse_id,
              a.articulo AS sku,
              a.factor_venta AS fv,
              a.unidad_venta AS unidad
             FROM wh w
               JOIN wincaja.articulos a ON a.tenant_id = w.tenant_id AND a.source_branch = w.wincaja_source_branch AND a.source_dataset = 'actual'::text
            WHERE w.kepler_code IS NULL AND (a.factor_venta > 1::numeric OR a.factor_venta = 1::numeric AND btrim(upper(a.unidad_venta)) = 'CJA'::text)
          ), base AS (
           SELECT w.tenant_id,
              w.id AS warehouse_id,
              w.code AS warehouse_code,
              w.kepler_code,
              p.id AS product_id,
              p.sku,
              GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) AS f_previo,
              wcf.fv AS wcf_fv,
              wcf.unidad AS wcf_unidad,
              bfx.source AS bfx_source,
              bfx.is_weight,
              bfx.is_master_suspect,
              sr.rung_max,
              kul.factor_caja AS kul_factor,
              kul.factor_source AS kul_source,
              lad.u3_label AS lad_u3,
              lad.u1_label AS lad_u1
             FROM wh w
               JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
               LEFT JOIN analytics.v_product_box_factor bfx ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
               LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku::text
               LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku::text
               LEFT JOIN analytics.mv_kepler_sold_rung sr ON sr.sucursal = w.kepler_code AND sr.sku = p.sku::text
               LEFT JOIN analytics.v_kepler_unit_ladder kul ON kul.sucursal = w.kepler_code AND kul.sku = btrim(p.sku::text)
          )
   SELECT tenant_id,
      warehouse_id,
      warehouse_code,
      product_id,
      sku,
          CASE
              WHEN kepler_code IS NOT NULL AND kul_factor IS NOT NULL THEN GREATEST(kul_factor, 1::numeric)
              WHEN f_previo = 1::numeric AND kepler_code IS NOT NULL AND rung_max > 1::numeric THEN rung_max
              ELSE f_previo
          END AS box_factor,
          CASE
              WHEN kepler_code IS NOT NULL AND kul_factor IS NOT NULL THEN
              CASE kul_source
                  WHEN 'unidad_unica'::text THEN 'kepler_unidad_unica'::text
                  WHEN 'derivado_del_costo'::text THEN 'kepler_ficha_costo'::text
                  WHEN 'capturado_contradice_al_costo'::text THEN 'kepler_ficha_contradice_costo'::text
                  ELSE 'kepler_ficha'::text
              END
              WHEN f_previo = 1::numeric AND kepler_code IS NOT NULL AND rung_max > 1::numeric THEN 'kepler_peldano_vendido'::text
              WHEN wcf_fv IS NOT NULL THEN 'wincaja_factor_venta'::text
              ELSE COALESCE(bfx_source, 'none'::text)
          END AS factor_source,
          CASE
              WHEN kepler_code IS NOT NULL THEN 'kepler'::text
              ELSE 'wincaja'::text
          END AS erp,
      lad_u3 AS box_label,
      COALESCE(wcf_unidad, lad_u1) AS base_label,
      COALESCE(is_weight, false) AS is_weight,
      COALESCE(is_master_suspect, false) AS is_master_suspect
     FROM base`;

const COMMENT_MV = 'PQ.40: el peldano COMPRADO por SKU (kdm2.c58 de X-A-20/35, 365 d, join de 7 columnas). Gemela de mv_kepler_sold_rung del lado de compra. La lee v_product_box_factor: cuando la ficha de Kepler no trae caja (kdii c81/c84 <= 1) y Kepler compro en UN solo peldano, ese peldano reemplaza a etiquetera/factor_sale (source kepler_peldano_comprado). Refresca AnalyticsRefreshService (job analytics_refresh_bought_rung).';

async function grants(knex, rel) {
  await knex.raw(`GRANT SELECT ON ${rel} TO app_runtime`);
  // dev_ro existe en prod, no necesariamente en la base del CI.
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    EXECUTE 'GRANT SELECT ON ${rel} TO dev_ro'; END IF; END $$`);
}

async function refrescar(knex) {
  for (const mv of ['analytics.mv_product_box_factor', 'analytics.mv_warehouse_box_factor']) {
    const t = (await knex.raw('SELECT to_regclass(?) t', [mv])).rows[0].t;
    if (t) await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
  }
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const v of ['v_product_box_factor', 'v_warehouse_box_factor', 'mv_kepler_sold_rung']) {
    const t = (await knex.raw('SELECT to_regclass(?) t', ['analytics.' + v])).rows[0].t;
    if (!t) throw new Error(`falta analytics.${v}: esta migración reemplaza su definición`);
  }
  const filasAntes = Number((await knex.raw('SELECT count(*) n FROM analytics.v_product_box_factor')).rows[0].n);

  await knex.raw(MV);
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS mv_kepler_bought_rung_pk ON analytics.mv_kepler_bought_rung (sku)');
  await knex.raw('ANALYZE analytics.mv_kepler_bought_rung');
  await grants(knex, 'analytics.mv_kepler_bought_rung');
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_bought_rung IS '${COMMENT_MV}'`);

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_product_box_factor AS ${PBF_NUEVA}`);
  await grants(knex, 'analytics.v_product_box_factor');
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS ${VBF_NUEVA}`);
  await grants(knex, 'analytics.v_warehouse_box_factor');

  // ── Auto-verificación: el universo no cambia y el alcance es el medido ──
  const filasDespues = Number((await knex.raw('SELECT count(*) n FROM analytics.v_product_box_factor')).rows[0].n);
  if (filasDespues !== filasAntes) {
    throw new Error(`v_product_box_factor cambió de universo: ${filasAntes} -> ${filasDespues}`);
  }
  const n = Number((await knex.raw(
    "SELECT count(*) n FROM analytics.v_product_box_factor WHERE source = 'kepler_peldano_comprado'")).rows[0].n);
  // Medido: 40 en prod. Cientos serían otra regla, no ésta.
  if (n > 400) throw new Error(`kepler_peldano_comprado en ${n} productos (el medido era 40): abortado`);
  console.log(`  [PQ.40] productos con caja = peldaño comprado: ${n}`);

  await refrescar(knex);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las dos vistas vuelven a su cuerpo previo y la MV se va. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_product_box_factor AS ${PBF_PREVIA}`);
  await grants(knex, 'analytics.v_product_box_factor');
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS ${VBF_PREVIA}`);
  await grants(knex, 'analytics.v_warehouse_box_factor');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_bought_rung');
  await refrescar(knex);
};
