'use strict';
/**
 * `[CE.1.6]` — El costo del ERP de UNA celda (almacén × producto) sin calcular las 250 mil: la
 * MISMA fórmula que `analytics.v_erp_unit_cost`, ahora en una función que comparten la vista
 * completa y la búsqueda por celda `analytics.erp_unit_cost_at(warehouse_id, product_id)`.
 *
 * POR QUÉ: «Por vencer» necesita el costo de ~73 lotes y pagaba el resolvedor completo (~1.4 s,
 * deuda de CE.1.5). La vista NO se puede filtrar por celda: sus dos fuentes son CTE MATERIALIZED a
 * propósito (PERF.1, mig 20260923120000: sin eso el planificador estimaba mal el cartesiano y
 * tardaba 42 s). Así que la vista completa NO cambia de forma, y se agrega el camino por celda.
 * Nada de copia ni de refresco: todo sigue derivado en vivo del ODS.
 *
 * ── Lo que hace ─────────────────────────────────────────────────────────────────────────────
 *  1. `analytics.erp_unit_cost_resolve(...)`: la fórmula (costo_erp, catálogo ciego, costo_unitario,
 *     costo_source, testigo, razón, veredicto), SQL inlineable. UNA sola implementación.
 *  2. `analytics.v_kepler_item_cost`: el decode de `kdik` (costo por sucursal × código), renglón por
 *     renglón y SIN agrupar, para que el filtro de una celda llegue a `kdik` (`ix_kdik_suc_btrim_c2`,
 *     mig hermana). `analytics.v_kepler_unit_cost` pasa a leerlo y CONSERVA su GROUP BY (el max):
 *     mismo resultado y mismo plan para quien la lee. ⛔ Aplanarla NO es opción: ensayado, su
 *     consumidor `analytics.v_erp_stock_truth` pasó de 1.7 s a más de 180 s (la trampa de PERF.1).
 *  3. `analytics.v_erp_unit_cost`: mismas columnas, mismas CTE MATERIALIZED; la lista de selección
 *     pasa a llamar a la fórmula.
 *  4. `analytics.erp_unit_cost_at(warehouse_id, product_id)`: el FROM de la vista para UNA celda.
 *     Se usa con `LEFT JOIN LATERAL analytics.erp_unit_cost_at(x.warehouse_id, x.product_id) uc ON true`.
 *
 * ── Lo medido antes (sólo lectura y ensayo con objetos pg_temp + ROLLBACK, prod, 2026-11-12) ──
 *  · `v_kepler_unit_cost` leyendo el decode: mismas 35,350 filas, mismo md5, ~500 ms ambas.
 *  · `v_erp_stock_truth` sobre esa vista: 33,156 filas, mismo md5, ~2.0 s ambas (aplanada: > 180 s).
 *  · `v_erp_unit_cost` con la fórmula en función: 250,316 celdas, mismo md5 de las 14 columnas,
 *    2.4 vs 2.5 s (ruido); la fórmula queda inlineada (sin `Function Scan`; el `up` lo aserta).
 *  · `erp_unit_cost_at` contra la vista en 3,000 celdas fijas (2,052 Kepler · 948 Wincaja): mismo md5.
 *  · Los 73 lotes de «Por vencer»: mismo md5; 1,527 → 392 ms SIN el índice (el índice va en la
 *    mig hermana; con la búsqueda exacta por llave se midió 10–25 ms).
 *
 * ⚠️ Al recrear una vista, `security_invoker` y los GRANT se declaran explícitos y se asertan
 *    (lección de PERF.1). Dependen de estas vistas: mv_erp_unit_cost, mv_kepler_unit_cost,
 *    v_abc_class, v_erp_stock_truth — CREATE OR REPLACE las conserva porque las columnas no cambian.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const RESOLVE = `
CREATE OR REPLACE FUNCTION analytics.erp_unit_cost_resolve(
  p_es_kepler boolean, p_costo_kepler numeric, p_costo_wincaja numeric,
  p_cost_base numeric, p_cost_with_tax numeric)
RETURNS TABLE (costo_erp numeric, costo_catalogo_ciego numeric, costo_unitario numeric,
               costo_source text, tiene_testigo boolean, razon numeric, veredicto text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT x.e,
         x.ciego,
         COALESCE(x.e, x.ciego),
         CASE
           WHEN p_es_kepler AND p_costo_kepler > 0::numeric THEN 'kepler_kdik'::text
           WHEN NOT p_es_kepler AND p_costo_wincaja > 0::numeric THEN 'wincaja_costo_promedio'::text
           WHEN COALESCE(p_cost_with_tax, 0::numeric) > 0::numeric AND p_cost_with_tax < p_cost_base
             THEN 'catalogo_columnas_invertidas'::text
           WHEN COALESCE(p_cost_base, 0::numeric) > 0::numeric THEN 'catalogo_neto'::text
           ELSE 'sin_costo'::text
         END,
         x.e > 0::numeric,
         CASE
           WHEN COALESCE(p_cost_base, 0::numeric) > 0::numeric AND COALESCE(x.e, 0::numeric) > 0::numeric
             THEN round(p_cost_base / x.e, 4)
           ELSE NULL::numeric
         END,
         CASE
           WHEN COALESCE(x.e, 0::numeric) <= 0::numeric THEN 'sin_testigo'::text
           WHEN COALESCE(p_cost_base, 0::numeric) <= 0::numeric THEN 'sin_costo_catalogo'::text
           WHEN abs(p_cost_base / x.e - 1::numeric) <= 0.02 THEN 'confirmado'::text
           WHEN (p_cost_base / x.e) >= 1.5 THEN 'contradicho_por_factor'::text
           WHEN (p_cost_base / x.e) <= 0.667 THEN 'contradicho_por_factor'::text
           ELSE 'precio_movido'::text
         END
    FROM (SELECT CASE WHEN p_es_kepler THEN p_costo_kepler ELSE p_costo_wincaja END AS e,
                 NULLIF(CASE WHEN COALESCE(p_cost_with_tax, 0::numeric) > 0::numeric
                              AND p_cost_with_tax < p_cost_base
                             THEN p_cost_with_tax ELSE p_cost_base END, 0::numeric) AS ciego) x
$fn$`;

/** El decode de `kdik`: costo por (sucursal, código), un renglón por renglón de `kdik`, SIN agrupar. */
const ITEM = `
CREATE OR REPLACE VIEW analytics.v_kepler_item_cost WITH (security_invoker = true) AS
SELECT k.sucursal AS kepler_code,
       btrim(k.c2) AS sku,
       CASE WHEN k.c16 = k.c16 AND k.c16 > '-Infinity'::double precision
             AND k.c16 < 'Infinity'::double precision
            THEN k.c16::numeric ELSE NULL::numeric END AS costo_unitario
  FROM kepler_ods.kdik k
 WHERE k.sucursal = btrim(k.c1)`;

/** La vista de siempre (mismo GROUP BY, mismo max), leyendo el decode en vez de repetirlo. */
const KEPLER_SOBRE_ITEM = `
CREATE OR REPLACE VIEW analytics.v_kepler_unit_cost WITH (security_invoker = true) AS
WITH kk AS (
  SELECT d.kepler_code, d.sku, max(d.costo_unitario) AS costo_unitario
    FROM analytics.v_kepler_item_cost d
   GROUP BY d.kepler_code, d.sku
)
SELECT w.tenant_id,
       w.id AS warehouse_id,
       w.kepler_code,
       p.id AS product_id,
       p.sku,
       kk.costo_unitario
  FROM kk
  JOIN commercial.warehouses w ON w.kepler_code = kk.kepler_code AND w.deleted_at IS NULL
  JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.sku::text = kk.sku AND p.deleted_at IS NULL
 WHERE kk.costo_unitario IS NOT NULL AND kk.costo_unitario > 0::numeric`;

/** La definición de HOY (decode dentro), para el `down`. */
const KEPLER_CON_GROUP = `
CREATE OR REPLACE VIEW analytics.v_kepler_unit_cost WITH (security_invoker = true) AS
WITH kk AS (
  SELECT k.sucursal AS kepler_code,
         btrim(k.c2) AS sku,
         max(CASE WHEN k.c16 = k.c16 AND k.c16 > '-Infinity'::double precision
                   AND k.c16 < 'Infinity'::double precision
                  THEN k.c16::numeric ELSE NULL::numeric END) AS costo_unitario
    FROM kepler_ods.kdik k
   WHERE k.sucursal = btrim(k.c1)
   GROUP BY k.sucursal, (btrim(k.c2))
)
SELECT w.tenant_id,
       w.id AS warehouse_id,
       w.kepler_code,
       p.id AS product_id,
       p.sku,
       kk.costo_unitario
  FROM kk
  JOIN commercial.warehouses w ON w.kepler_code = kk.kepler_code AND w.deleted_at IS NULL
  JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.sku::text = kk.sku AND p.deleted_at IS NULL
 WHERE kk.costo_unitario IS NOT NULL AND kk.costo_unitario > 0::numeric`;

/** Las 14 columnas del contrato de la vista; `r` es la fórmula. */
const SELECT_14 = `
  SELECT w.tenant_id,
         w.id AS warehouse_id,
         w.code AS warehouse_code,
         CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler'::text ELSE 'wincaja'::text END AS erp,
         p.id AS product_id,
         p.sku,
         r.costo_erp,
         p.cost_base AS costo_catalogo,
         r.costo_catalogo_ciego::numeric(14,4) AS costo_catalogo_ciego,
         r.costo_unitario,
         r.costo_source,
         r.tiene_testigo,
         r.razon,
         r.veredicto`;

const LA_FORMULA = `
    CROSS JOIN LATERAL analytics.erp_unit_cost_resolve(
      w.kepler_code IS NOT NULL, kc.costo_unitario, wv.costo_promedio, p.cost_base, p.cost_with_tax) r`;

/** La vista completa: mismas CTE MATERIALIZED de PERF.1; sólo la lista de selección cambia. */
const ERP_COMPLETA = `
CREATE OR REPLACE VIEW analytics.v_erp_unit_cost WITH (security_invoker = true) AS
WITH kc AS MATERIALIZED (
  SELECT tenant_id, warehouse_id, product_id, costo_unitario
    FROM analytics.v_kepler_unit_cost
), wv AS MATERIALIZED (
  SELECT tenant_id, source_branch, sku, costo_promedio
    FROM wincaja.v_stock
   WHERE costo_promedio > 0::numeric
)
${SELECT_14}
    FROM commercial.warehouses w
    JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN kc ON w.kepler_code IS NOT NULL AND kc.tenant_id = w.tenant_id
                AND kc.warehouse_id = w.id AND kc.product_id = p.id
    LEFT JOIN wv ON w.kepler_code IS NULL AND wv.tenant_id = w.tenant_id
                AND wv.source_branch = w.wincaja_source_branch AND wv.sku = p.sku::text
    ${LA_FORMULA}
   WHERE w.deleted_at IS NULL AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)`;

/**
 * UNA celda: el mismo FROM que la vista, con cada fuente buscada sólo para esta celda. El renglón de
 * Kepler es el de `v_kepler_unit_cost` para (w, p): el max del decode de su sucursal × código, si es > 0.
 */
const POR_CELDA = `
CREATE OR REPLACE FUNCTION analytics.erp_unit_cost_at(p_warehouse_id uuid, p_product_id uuid)
RETURNS TABLE (tenant_id uuid, warehouse_id uuid, warehouse_code varchar, erp text,
               product_id uuid, sku varchar, costo_erp numeric, costo_catalogo numeric,
               costo_catalogo_ciego numeric, costo_unitario numeric, costo_source text,
               tiene_testigo boolean, razon numeric, veredicto text)
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
${SELECT_14}
    FROM commercial.warehouses w
    JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT x.costo_unitario
        FROM (SELECT max(d.costo_unitario) AS costo_unitario
                FROM analytics.v_kepler_item_cost d
               WHERE d.kepler_code = w.kepler_code AND d.sku = p.sku::text) x
       WHERE w.kepler_code IS NOT NULL AND x.costo_unitario > 0::numeric) kc ON true
    LEFT JOIN LATERAL (
      SELECT s.costo_promedio
        FROM wincaja.v_stock s
       WHERE w.kepler_code IS NULL AND s.tenant_id = w.tenant_id
         AND s.source_branch = w.wincaja_source_branch AND s.sku = p.sku::text
         AND s.costo_promedio > 0::numeric) wv ON true
    ${LA_FORMULA}
   WHERE w.id = p_warehouse_id AND p.id = p_product_id
     AND w.deleted_at IS NULL AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
$fn$`;

async function asertar(knex) {
  const r = (
    await knex.raw(`
    SELECT
      (SELECT COALESCE(array_to_string(reloptions, ','), '') LIKE '%security_invoker=true%'
         FROM pg_class WHERE oid = 'analytics.v_erp_unit_cost'::regclass) AS inv_erp,
      (SELECT COALESCE(array_to_string(reloptions, ','), '') LIKE '%security_invoker=true%'
         FROM pg_class WHERE oid = 'analytics.v_kepler_unit_cost'::regclass) AS inv_kep,
      (SELECT COALESCE(array_to_string(reloptions, ','), '') LIKE '%security_invoker=true%'
         FROM pg_class WHERE oid = 'analytics.v_kepler_item_cost'::regclass) AS inv_item,
      has_table_privilege('app_runtime', 'analytics.v_erp_unit_cost', 'SELECT') AS lee_erp,
      has_table_privilege('app_runtime', 'analytics.v_kepler_unit_cost', 'SELECT') AS lee_kep,
      has_table_privilege('app_runtime', 'analytics.v_kepler_item_cost', 'SELECT') AS lee_item,
      has_function_privilege('app_runtime',
        'analytics.erp_unit_cost_at(uuid, uuid)', 'EXECUTE') AS ejecuta_at,
      has_function_privilege('app_runtime',
        'analytics.erp_unit_cost_resolve(boolean, numeric, numeric, numeric, numeric)', 'EXECUTE') AS ejecuta_resolve`)
  ).rows[0];
  for (const [k, v] of Object.entries(r)) {
    if (v !== true) throw new Error(`[CE.1.6] aserto fallido: ${k}`);
  }
  // ⛔ Si la fórmula NO se inlinea, la vista completa la llamaría 250 mil veces.
  const plan = (await knex.raw(`EXPLAIN SELECT count(costo_unitario) FROM analytics.v_erp_unit_cost`)).rows
    .map((x) => x['QUERY PLAN'])
    .join('\n');
  if (/Function Scan/.test(plan)) throw new Error('[CE.1.6] la fórmula no se inlineó en la vista:\n' + plan);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(RESOLVE);
  await knex.raw(ITEM);
  await knex.raw(KEPLER_SOBRE_ITEM);
  await knex.raw(ERP_COMPLETA);
  await knex.raw(POR_CELDA);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_item_cost, analytics.v_kepler_unit_cost, analytics.v_erp_unit_cost TO app_runtime`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION
      analytics.erp_unit_cost_resolve(boolean, numeric, numeric, numeric, numeric),
      analytics.erp_unit_cost_at(uuid, uuid) TO app_runtime`);
  await asertar(knex);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las dos vistas vuelven a su texto previo y se quita lo nuevo. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await require('./20260923120000_v_erp_unit_cost_hash_join.js').up(knex);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.erp_unit_cost_at(uuid, uuid)`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.erp_unit_cost_resolve(boolean, numeric, numeric, numeric, numeric)`);
  await knex.raw(KEPLER_CON_GROUP);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_item_cost`);
};

// Para el ensayo y la prueba de la spec: el mismo texto que corre el `up`.
exports.SQL = { RESOLVE, ITEM, KEPLER_SOBRE_ITEM, ERP_COMPLETA, POR_CELDA };
