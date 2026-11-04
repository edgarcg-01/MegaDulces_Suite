'use strict';
/**
 * `[PQ.41]` El árbitro del peldaño compara contra el costo por unidad BASE, y la unidad en que
 * Kepler asentó la compra se reconoce por su PRECIO, no por su etiqueta.
 *
 * El caso que lo abrió (PM, 2026-11-04): «aún existen productos con un símbolo de advertencia» en
 * /compras/pedido. El triángulo es `rung_veredicto` (x1_inflada / x2_deflactada): el divisor de
 * caja que usamos contra `caja_cost / pagado`. `pagado` era `real_buy_cost` = importe ÷ cantidad
 * ASENTADA de las entradas X-A-40, y Kepler no siempre asienta en la unidad base de la ficha:
 *
 *   · 06025 M&M: captura CJA, asienta 800 **PAQ** (c58=32) a $74.58 = el costo del PAQ. Dividido
 *     contra la caja de 192 PZA, el árbitro esperaba 32 y marcaba la caja «deflactada».
 *   · 97392 BON-BON: asienta 708 **CJA** con c58=1 a $319.70 (la caja). Esperaba 1 contra 10.
 *   · ⛔ Y la etiqueta `c11` miente: en el 23001 una entrada dice CJA y trae 480 unidades a $22.08,
 *     el costo de la unidad base. Leer la etiqueta pasaba 36 productos sanos a «inflados» — medido y
 *     descartado antes de escribir ésta.
 *
 * Regla: por renglón, el precio asentado (`c12`) se compara con el costo estándar de la ficha de
 * ESA sucursal (`kdii.c77` × 1, × c81, × c84, ±15 %) y eso dice cuántas unidades base trae cada
 * unidad asentada. El costo por base es Σ importe ÷ Σ (cantidad × ese factor), 365 días. Sólo se
 * usa cuando hubo compras asentadas FUERA de la base; si todas lo fueron en la base, el árbitro es
 * el de siempre. Un renglón cuyo precio no casa con ningún peldaño de la ficha no entra.
 *
 * ⭐ Lo que NO se puede arbitrar se declara: si todas las compras se asentaron en la caja misma y el
 * divisor ES el de esa caja, la prueba sería circular (convertir con el factor que se quiere
 * probar) → `z_no_arbitrable`, no `ok`.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-04) ───────────────────────────────────────
 *  · Control: el cuerpo vigente corrido como subconsulta = la vista, EXCEPT ALL 0 filas.
 *  · 22,199 filas antes y después; 2.4 s → 2.6 s.
 *  · Marcados: 428 celdas / 138 SKU → 316 celdas / ~104 SKU. **Ninguna celda pasa a marcada**:
 *      x2→ok 83 celdas (27 SKU) · x2→z_no_arbitrable 23 (5: 20601 59308 97275 97391 97392)
 *      · x1→ok 6 (95436) · ok→z_no_arbitrable 16 (4: 44226 44227 95848 99506).
 *  · Testigo independiente (dinero, no factores): en los que se limpian, el inventario publicado
 *    queda por debajo de lo comprado en 365 d; el «arbitrado» viejo lo superaba hasta 18× (97392:
 *    $4.18M contra $226k comprados). El 97392 queda no arbitrable, no «bien».
 *  · Siguen marcados, y con razón: los ZUKO (48xxx) — Kepler asienta en PZA (sobre) y la ficha no
 *    tiene esa unidad — y los que asientan en base con costo que contradice la caja. Ésos son de
 *    Compras, en la ficha de Kepler.
 *
 * No cambia columnas: `CREATE OR REPLACE` conserva permisos y dependientes. Sólo DDL de una vista
 * (sin datos); el valuado de /compras/pedido cambia cuando el plan vuelve a correr.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const NUEVA = `
  WITH kfi AS (
           SELECT btrim(k.sucursal) AS suc,
              btrim(k.c1) AS sku,
              upper(btrim(k.c11)) AS u1,
              upper(btrim(k.c80)) AS u2,
              upper(btrim(k.c83)) AS u3,
              NULLIF(regexp_replace(k.c81::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS f2,
              NULLIF(regexp_replace(k.c84::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS f3,
              NULLIF(regexp_replace(k.c77::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS c1
             FROM kepler_ods.kdii k
            WHERE btrim(COALESCE(k.c1, ''::text)) <> ''::text
          ), kln AS (
           SELECT btrim(d.c8) AS sku,
              NULLIF(btrim(d.c13::text), ''::text)::numeric AS importe,
              NULLIF(btrim(d.c9::text), ''::text)::numeric AS cant,
                  CASE
                      WHEN f.c1 > 0::numeric AND NULLIF(btrim(d.c12::text), ''::text)::numeric BETWEEN f.c1 * 0.85 AND f.c1 * 1.15 THEN 1::numeric
                      WHEN f.c1 > 0::numeric AND f.f2 > 1::numeric AND NULLIF(btrim(d.c12::text), ''::text)::numeric BETWEEN f.c1 * f.f2 * 0.85 AND f.c1 * f.f2 * 1.15 THEN f.f2
                      WHEN f.c1 > 0::numeric AND f.f3 > 1::numeric AND NULLIF(btrim(d.c12::text), ''::text)::numeric BETWEEN f.c1 * f.f3 * 0.85 AND f.c1 * f.f3 * 1.15 THEN f.f3
                      ELSE NULL::numeric
                  END AS fa
             FROM kepler_ods.kdm2 d
               JOIN kepler_ods.kdm1 h ON h.sucursal = d.sucursal AND h.c1 = d.c1 AND h.c2 = d.c2 AND h.c3 = d.c3 AND h.c4 = d.c4 AND h.c5 = d.c5 AND h.c6 = d.c6
               LEFT JOIN kfi f ON f.suc = btrim(d.sucursal) AND f.sku = btrim(d.c8)
            WHERE d.c2 = 'X'::text AND d.c3 = 'A'::text AND btrim(d.c4::text) = '40'::text AND h.c9 >= (CURRENT_DATE - 365)
          ), kp AS (
           SELECT kln.sku,
              sum(kln.importe) FILTER (WHERE kln.fa IS NOT NULL) / NULLIF(sum(kln.cant * kln.fa) FILTER (WHERE kln.fa IS NOT NULL), 0::numeric) AS pagado_base,
              count(*) FILTER (WHERE kln.fa > 1::numeric) AS lineas_fuera_de_base,
              min(kln.fa) AS fa_min,
              max(kln.fa) AS fa_max
             FROM kln
            WHERE kln.cant > 0::numeric AND kln.importe > 0::numeric
            GROUP BY kln.sku
          ), plan AS (
           SELECT rp.tenant_id,
              rp.product_id,
              rp.warehouse_id,
              w.code AS warehouse_code,
              w.kepler_code IS NOT NULL AS es_kepler,
              p.sku,
              p.nombre,
              rp.stock_pz,
              rp.suf,
              rp.bf,
              GREATEST(COALESCE(rp.display_bf, rp.bf, 1::numeric), 1::numeric) AS display_bf,
              rp.caja_cost,
              rp.real_buy_cost,
              rp.revenue30,
              rp.daily_pieces
             FROM analytics.replenishment_plan rp
               JOIN commercial.warehouses w ON w.tenant_id = rp.tenant_id AND w.id = rp.warehouse_id
               JOIN catalog.products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
            WHERE rp.stock_pz > 0::numeric AND rp.caja_cost > 0::numeric
          ), wcj AS (
           SELECT v.tenant_id,
              w.id AS warehouse_id,
              p.id AS product_id,
              v.costo_promedio
             FROM wincaja.v_stock v
               JOIN commercial.warehouses w ON w.tenant_id = v.tenant_id AND w.wincaja_source_branch = v.source_branch AND w.kepler_code IS NULL AND w.deleted_at IS NULL
               JOIN catalog.products p ON p.tenant_id = v.tenant_id AND p.sku::text = v.sku AND p.deleted_at IS NULL
            WHERE v.costo_promedio > 0::numeric
          ), a AS (
           SELECT pl.tenant_id,
              pl.product_id,
              pl.warehouse_id,
              pl.warehouse_code,
              pl.es_kepler,
              pl.sku,
              pl.nombre,
              pl.stock_pz,
              pl.suf,
              pl.bf,
              pl.display_bf,
              pl.caja_cost,
              pl.real_buy_cost,
              pl.revenue30,
              pl.daily_pieces,
              wc.costo_promedio,
              pl.es_kepler AND kp.lineas_fuera_de_base > 0 AND kp.fa_min = kp.fa_max AND kp.fa_max = pl.display_bf AS circular,
                  CASE
                      WHEN pl.es_kepler THEN 'kepler_compra'::text
                      ELSE 'wincaja_costo'::text
                  END AS arbitro,
                  CASE
                      WHEN pl.es_kepler AND kp.lineas_fuera_de_base > 0 AND kp.pagado_base > 0::numeric THEN kp.pagado_base
                      WHEN pl.es_kepler THEN NULLIF(pl.real_buy_cost, 0::numeric)
                      ELSE COALESCE(NULLIF(wc.costo_promedio, 0::numeric), NULLIF(pl.real_buy_cost, 0::numeric))
                  END AS pagado
             FROM plan pl
               LEFT JOIN wcj wc ON wc.tenant_id = pl.tenant_id AND wc.warehouse_id = pl.warehouse_id AND wc.product_id = pl.product_id
               LEFT JOIN kp ON kp.sku = pl.sku::text
          ), b AS (
           SELECT a.tenant_id,
              a.product_id,
              a.warehouse_id,
              a.warehouse_code,
              a.es_kepler,
              a.sku,
              a.nombre,
              a.stock_pz,
              a.suf,
              a.bf,
              a.display_bf,
              a.caja_cost,
              a.real_buy_cost,
              a.revenue30,
              a.daily_pieces,
              a.costo_promedio,
              a.arbitro,
              a.pagado,
                  CASE
                      WHEN a.circular THEN NULL::numeric
                      WHEN a.pagado > 0::numeric THEN a.caja_cost / a.pagado
                      ELSE NULL::numeric
                  END AS display_bf_esperado
             FROM a
          )
   SELECT b.tenant_id,
      b.warehouse_id,
      b.warehouse_code,
      b.product_id,
      b.sku,
      b.nombre,
      b.arbitro,
      b.stock_pz,
      b.suf,
      b.bf,
      b.display_bf,
      round(b.display_bf_esperado, 4) AS display_bf_esperado,
      round(b.display_bf / NULLIF(b.display_bf_esperado, 0::numeric), 4) AS razon,
      round(b.caja_cost, 4) AS caja_cost,
      round(b.pagado, 4) AS pagado,
      round(b.stock_pz / b.display_bf * b.caja_cost, 2) AS valor_publicado,
      round(b.stock_pz * b.pagado, 2) AS valor_arbitrado,
      round(b.revenue30, 2) AS revenue30,
          CASE
              WHEN b.display_bf_esperado IS NULL THEN 'z_no_arbitrable'::text
              WHEN (b.display_bf / b.display_bf_esperado) >= 0.60 AND (b.display_bf / b.display_bf_esperado) <= 1.70 THEN 'ok'::text
              WHEN b.display_bf < b.display_bf_esperado THEN 'x1_inflada'::text
              ELSE 'x2_deflactada'::text
          END AS veredicto,
      COALESCE(ul.is_weight, false) AS es_granel,
      uov.product_id IS NOT NULL AS con_override,
      uov.sold_as AS override_sold_as,
      b.suf > 1::numeric AND b.bf <= 1::numeric AS factor_partido,
      vbf.factor_source,
      vbf.box_label,
      vbf.base_label
     FROM b
       LEFT JOIN analytics.v_product_unit_ladder ul ON ul.sku = b.sku::text
       LEFT JOIN commercial.product_unit_overrides uov ON uov.tenant_id = b.tenant_id AND uov.product_id = b.product_id AND uov.deleted_at IS NULL
       LEFT JOIN analytics.v_warehouse_box_factor vbf ON vbf.tenant_id = b.tenant_id AND vbf.warehouse_id = b.warehouse_id AND vbf.product_id = b.product_id`;

const PREVIA = `
  WITH plan AS (
           SELECT rp.tenant_id,
              rp.product_id,
              rp.warehouse_id,
              w.code AS warehouse_code,
              w.kepler_code IS NOT NULL AS es_kepler,
              p.sku,
              p.nombre,
              rp.stock_pz,
              rp.suf,
              rp.bf,
              GREATEST(COALESCE(rp.display_bf, rp.bf, 1::numeric), 1::numeric) AS display_bf,
              rp.caja_cost,
              rp.real_buy_cost,
              rp.revenue30,
              rp.daily_pieces
             FROM analytics.replenishment_plan rp
               JOIN commercial.warehouses w ON w.tenant_id = rp.tenant_id AND w.id = rp.warehouse_id
               JOIN catalog.products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
            WHERE rp.stock_pz > 0::numeric AND rp.caja_cost > 0::numeric
          ), wcj AS (
           SELECT v.tenant_id,
              w.id AS warehouse_id,
              p.id AS product_id,
              v.costo_promedio
             FROM wincaja.v_stock v
               JOIN commercial.warehouses w ON w.tenant_id = v.tenant_id AND w.wincaja_source_branch = v.source_branch AND w.kepler_code IS NULL AND w.deleted_at IS NULL
               JOIN catalog.products p ON p.tenant_id = v.tenant_id AND p.sku::text = v.sku AND p.deleted_at IS NULL
            WHERE v.costo_promedio > 0::numeric
          ), a AS (
           SELECT pl.tenant_id,
              pl.product_id,
              pl.warehouse_id,
              pl.warehouse_code,
              pl.es_kepler,
              pl.sku,
              pl.nombre,
              pl.stock_pz,
              pl.suf,
              pl.bf,
              pl.display_bf,
              pl.caja_cost,
              pl.real_buy_cost,
              pl.revenue30,
              pl.daily_pieces,
              wc.costo_promedio,
                  CASE
                      WHEN pl.es_kepler THEN 'kepler_compra'::text
                      ELSE 'wincaja_costo'::text
                  END AS arbitro,
                  CASE
                      WHEN pl.es_kepler THEN NULLIF(pl.real_buy_cost, 0::numeric)
                      ELSE COALESCE(NULLIF(wc.costo_promedio, 0::numeric), NULLIF(pl.real_buy_cost, 0::numeric))
                  END AS pagado
             FROM plan pl
               LEFT JOIN wcj wc ON wc.tenant_id = pl.tenant_id AND wc.warehouse_id = pl.warehouse_id AND wc.product_id = pl.product_id
          ), b AS (
           SELECT a.tenant_id,
              a.product_id,
              a.warehouse_id,
              a.warehouse_code,
              a.es_kepler,
              a.sku,
              a.nombre,
              a.stock_pz,
              a.suf,
              a.bf,
              a.display_bf,
              a.caja_cost,
              a.real_buy_cost,
              a.revenue30,
              a.daily_pieces,
              a.costo_promedio,
              a.arbitro,
              a.pagado,
                  CASE
                      WHEN a.pagado > 0::numeric THEN a.caja_cost / a.pagado
                      ELSE NULL::numeric
                  END AS display_bf_esperado
             FROM a
          )
   SELECT b.tenant_id,
      b.warehouse_id,
      b.warehouse_code,
      b.product_id,
      b.sku,
      b.nombre,
      b.arbitro,
      b.stock_pz,
      b.suf,
      b.bf,
      b.display_bf,
      round(b.display_bf_esperado, 4) AS display_bf_esperado,
      round(b.display_bf / NULLIF(b.display_bf_esperado, 0::numeric), 4) AS razon,
      round(b.caja_cost, 4) AS caja_cost,
      round(b.pagado, 4) AS pagado,
      round(b.stock_pz / b.display_bf * b.caja_cost, 2) AS valor_publicado,
      round(b.stock_pz * b.pagado, 2) AS valor_arbitrado,
      round(b.revenue30, 2) AS revenue30,
          CASE
              WHEN b.display_bf_esperado IS NULL THEN 'z_no_arbitrable'::text
              WHEN (b.display_bf / b.display_bf_esperado) >= 0.60 AND (b.display_bf / b.display_bf_esperado) <= 1.70 THEN 'ok'::text
              WHEN b.display_bf < b.display_bf_esperado THEN 'x1_inflada'::text
              ELSE 'x2_deflactada'::text
          END AS veredicto,
      COALESCE(ul.is_weight, false) AS es_granel,
      uov.product_id IS NOT NULL AS con_override,
      uov.sold_as AS override_sold_as,
      b.suf > 1::numeric AND b.bf <= 1::numeric AS factor_partido,
      vbf.factor_source,
      vbf.box_label,
      vbf.base_label
     FROM b
       LEFT JOIN analytics.v_product_unit_ladder ul ON ul.sku = b.sku::text
       LEFT JOIN commercial.product_unit_overrides uov ON uov.tenant_id = b.tenant_id AND uov.product_id = b.product_id AND uov.deleted_at IS NULL
       LEFT JOIN analytics.v_warehouse_box_factor vbf ON vbf.tenant_id = b.tenant_id AND vbf.warehouse_id = b.warehouse_id AND vbf.product_id = b.product_id`;

const T = '00000000-0000-0000-0000-00000000d01c';
const marcados = async (knex) => Number((await knex.raw(
  `SELECT count(*) n FROM analytics.v_unit_rung_audit WHERE tenant_id = '${T}' AND veredicto IN ('x1_inflada','x2_deflactada')`)).rows[0].n);
const filas = async (knex) => Number((await knex.raw(
  `SELECT count(*) n FROM analytics.v_unit_rung_audit WHERE tenant_id = '${T}'`)).rows[0].n);

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const t = (await knex.raw("SELECT to_regclass('analytics.v_unit_rung_audit') t")).rows[0].t;
  if (!t) throw new Error('falta analytics.v_unit_rung_audit: esta migración reemplaza su definición');
  const filasAntes = await filas(knex);
  const antes = await marcados(knex);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_unit_rung_audit AS ${NUEVA}`);
  const filasDespues = await filas(knex);
  const despues = await marcados(knex);
  if (filasAntes !== filasDespues) throw new Error(`v_unit_rung_audit cambió de universo: ${filasAntes} -> ${filasDespues}`);
  // La regla sólo puede QUITAR marcas (medido: 428 -> 316). Si suma, algo distinto pasó: se aborta.
  if (despues > antes) throw new Error(`el árbitro nuevo MARCA más celdas (${antes} -> ${despues}): abortado`);
  console.log(`[PQ.41] celdas sin valuar: ${antes} -> ${despues} (filas ${filasDespues})`);
};

exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_unit_rung_audit AS ${PREVIA}`);
};
