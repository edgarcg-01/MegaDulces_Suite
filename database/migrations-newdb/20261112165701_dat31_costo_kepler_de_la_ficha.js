'use strict';
/**
 * `[AUD-DAT.31]` — En un almacén de Kepler el costo sale TODO del ODS: `kdik` y, donde `kdik` no
 * tiene la celda, el costo de la ficha de Kepler de ESA sucursal (`kepler_ods.kdii.c77`). El
 * catálogo (`catalog.products.cost_base`, lo escriben importers) deja de valuar celdas de Kepler.
 * Sin `kdik` ni ficha, la celda se DECLARA `sin_costo` (nunca se rellena).
 *
 * POR QUÉ: «todo, absolutamente todo debe salir del ODS» (Edgar, 2026-11-12). `analytics.v_erp_unit_cost`
 * valuaba 104,340 celdas de Kepler con el catálogo.
 *
 * ⛔ Wincaja YA NO EXISTE (Edgar, 2026-11-12) y sale del resolvedor: sólo almacenes de Kepler. Medido: sus
 *    únicos almacenes propios son los 7 `RUTA-*` (sin clave de Kepler); `wincaja.existencias` no se
 *    importa desde el 2026-09-29; `analytics.v_erp_stock_on_hand` ya no trae ni un renglón de Wincaja;
 *    `commercial.stock` y `stock_lots` tienen 0 renglones en esos almacenes. Sus 79,653 celdas de costo
 *    (71,266 con un costo de la copia congelada) dejan de publicarse. Lo único que aún los nombra es
 *    `analytics.replenishment_plan` (4,315 renglones de rutas): ahí el costo queda vacío, no inventado.
 *
 * ── Lo medido antes (prod, sólo lectura con tablas temporales + ROLLBACK, 2026-11-12) ────────
 *  · ⭐ Árbitro de la unidad: en las 35,242 celdas que tienen `kdik` Y ficha, la ficha cae a ±10 % de
 *    `kdik` en 32,072 (91 %), a ±33 % en 34,295 (97 %); mediana de la razón 1.000. Misma unidad (base).
 *  · Las 104,340 celdas de catálogo en Kepler: 45,594 tienen ficha con costo → `kepler_ficha`;
 *    58,438 son productos que NO están en la ficha de esa sucursal (existencia 0 en todas: costo
 *    inventado para una combinación que no existe) → `sin_costo`; 308 están en la ficha sin costo.
 *  · Lo que mueve en existencia (ODS): 31 celdas, $18,236 valuados con catálogo → $13,980 con ficha
 *    (7 celdas, $2,993, quedan sin costo). Contra $70.7 M valuados con `kdik`.
 *  · El costo de $0.01 de la ficha NO es un marcador: son promociones («… = GRATIS 1 …») y `kdik` y
 *    el catálogo dicen lo mismo. Se acepta igual que hoy en `kdik`.
 *  · `c77` es texto: 83,928 limpios, 1,963 con punto inicial (`.01`), 463 vacíos, 0 negativos. El
 *    decode acepta `^[0-9]*\.?[0-9]+$` y lo demás es NULL: un valor raro NO tumba la vista.
 *
 * ── Lo que hace ─────────────────────────────────────────────────────────────────────────────
 *  1. `analytics.v_kepler_ficha_cost`: el decode de la ficha (sucursal × código → costo), sin agrupar,
 *     para que el filtro de UNA celda llegue a `kdii` (`ix_kdii_suc_sku`).
 *  2. `analytics.erp_unit_cost_resolve(kdik, cost_base, cost_with_tax, ficha)`: la fórmula sólo de
 *     Kepler; la de 5 argumentos (con la rama Wincaja) se retira (nadie más la llama).
 *  3. `analytics.v_erp_unit_cost` y `analytics.erp_unit_cost_at`: mismas 14 columnas (`erp` = 'kepler'),
 *     misma forma (CTE MATERIALIZED de PERF.1); sin la CTE de `wincaja.v_stock`, con la de la ficha.
 *     ⛔ `kc` ya NO lee `v_kepler_unit_cost` por (almacén, producto): sin la CTE de Wincaja el planificador
 *     estimó 11 renglones (son 35 mil), eligió un merge join por almacén y la vista pasó de 1.3 s a 40 s
 *     (ensayado). Ahora `kc` y `kf` se empatan igual, por (sucursal Kepler, código), con hash join.
 *     Mismo resultado: `v_kepler_unit_cost` es ese max > 0 cruzado con almacenes y productos vivos.
 *  `costo_erp`, `tiene_testigo`, `razon` y `veredicto` NO cambian: el testigo sigue siendo `kdik`. La
 *  ficha es procedencia declarada (`kepler_ficha`), no testigo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const FICHA = `
CREATE OR REPLACE VIEW analytics.v_kepler_ficha_cost WITH (security_invoker = true) AS
SELECT btrim(k.sucursal) AS kepler_code,
       btrim(k.c1) AS sku,
       CASE WHEN btrim(k.c77) ~ '^[0-9]*\\.?[0-9]+$' THEN btrim(k.c77)::numeric ELSE NULL::numeric END AS costo_ficha
  FROM kepler_ods.kdii k
 WHERE btrim(COALESCE(k.c1, ''::text)) <> ''::text`;

const RESOLVE = `
CREATE OR REPLACE FUNCTION analytics.erp_unit_cost_resolve(
  p_costo_kepler numeric, p_cost_base numeric, p_cost_with_tax numeric, p_costo_ficha numeric)
RETURNS TABLE (costo_erp numeric, costo_catalogo_ciego numeric, costo_unitario numeric,
               costo_source text, tiene_testigo boolean, razon numeric, veredicto text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT x.e,
         x.ciego,
         COALESCE(x.e, x.ficha),
         CASE
           WHEN x.e > 0::numeric THEN 'kepler_kdik'::text
           WHEN x.ficha IS NOT NULL THEN 'kepler_ficha'::text
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
    FROM (SELECT p_costo_kepler AS e,
                 NULLIF(CASE WHEN COALESCE(p_cost_with_tax, 0::numeric) > 0::numeric
                              AND p_cost_with_tax < p_cost_base
                             THEN p_cost_with_tax ELSE p_cost_base END, 0::numeric) AS ciego,
                 CASE WHEN p_costo_ficha > 0::numeric THEN p_costo_ficha END AS ficha) x
$fn$`;

const SELECT_14 = `
  SELECT w.tenant_id,
         w.id AS warehouse_id,
         w.code AS warehouse_code,
         'kepler'::text AS erp,
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
      kc.costo_unitario, p.cost_base, p.cost_with_tax, kf.costo_ficha) r`;

const ERP_COMPLETA = `
CREATE OR REPLACE VIEW analytics.v_erp_unit_cost WITH (security_invoker = true) AS
WITH kc AS MATERIALIZED (
  SELECT d.kepler_code, d.sku, max(d.costo_unitario) AS costo_unitario
    FROM analytics.v_kepler_item_cost d
   GROUP BY d.kepler_code, d.sku
  HAVING max(d.costo_unitario) > 0::numeric
), kf AS MATERIALIZED (
  SELECT f.kepler_code, f.sku, max(f.costo_ficha) AS costo_ficha
    FROM analytics.v_kepler_ficha_cost f
   WHERE f.costo_ficha > 0::numeric
   GROUP BY f.kepler_code, f.sku
)
${SELECT_14}
    FROM commercial.warehouses w
    JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN kc ON kc.kepler_code = w.kepler_code AND kc.sku = p.sku::text
    LEFT JOIN kf ON kf.kepler_code = w.kepler_code AND kf.sku = p.sku::text
    ${LA_FORMULA}
   WHERE w.deleted_at IS NULL AND w.kepler_code IS NOT NULL`;

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
       WHERE x.costo_unitario > 0::numeric) kc ON true
    LEFT JOIN LATERAL (
      SELECT max(f.costo_ficha) AS costo_ficha
        FROM analytics.v_kepler_ficha_cost f
       WHERE f.kepler_code = w.kepler_code AND f.sku = p.sku::text
         AND f.costo_ficha > 0::numeric) kf ON true
    ${LA_FORMULA}
   WHERE w.id = p_warehouse_id AND p.id = p_product_id
     AND w.deleted_at IS NULL AND w.kepler_code IS NOT NULL
$fn$`;

const VIEJA = 'analytics.erp_unit_cost_resolve(boolean, numeric, numeric, numeric, numeric)';
const NUEVA = 'analytics.erp_unit_cost_resolve(numeric, numeric, numeric, numeric)';

async function asertar(knex) {
  const r = (
    await knex.raw(`
    SELECT
      (SELECT COALESCE(array_to_string(reloptions, ','), '') LIKE '%security_invoker=true%'
         FROM pg_class WHERE oid = 'analytics.v_erp_unit_cost'::regclass) AS inv_erp,
      (SELECT COALESCE(array_to_string(reloptions, ','), '') LIKE '%security_invoker=true%'
         FROM pg_class WHERE oid = 'analytics.v_kepler_ficha_cost'::regclass) AS inv_ficha,
      has_table_privilege('app_runtime', 'analytics.v_erp_unit_cost', 'SELECT') AS lee_erp,
      has_table_privilege('app_runtime', 'analytics.v_kepler_ficha_cost', 'SELECT') AS lee_ficha,
      has_function_privilege('app_runtime', 'analytics.erp_unit_cost_at(uuid, uuid)', 'EXECUTE') AS ejecuta_at,
      has_function_privilege('app_runtime', '${NUEVA}', 'EXECUTE') AS ejecuta_resolve,
      to_regprocedure('${VIEJA}') IS NULL AS vieja_retirada`)
  ).rows[0];
  for (const [k, v] of Object.entries(r)) {
    if (v !== true) throw new Error(`[AUD-DAT.31] aserto fallido: ${k}`);
  }
  // ⛔ Si la fórmula NO se inlinea, la vista completa la llamaría 250 mil veces.
  const plan = (await knex.raw(`EXPLAIN SELECT count(costo_unitario) FROM analytics.v_erp_unit_cost`)).rows
    .map((x) => x['QUERY PLAN'])
    .join('\n');
  if (/Function Scan/.test(plan)) throw new Error('[AUD-DAT.31] la fórmula no se inlineó en la vista:\n' + plan);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(FICHA);
  await knex.raw(RESOLVE);
  await knex.raw(ERP_COMPLETA);
  await knex.raw(POR_CELDA);
  await knex.raw(`DROP FUNCTION IF EXISTS ${VIEJA}`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_ficha_cost, analytics.v_erp_unit_cost TO app_runtime`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION ${NUEVA}, analytics.erp_unit_cost_at(uuid, uuid) TO app_runtime`);
  await asertar(knex);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la fórmula, la vista y la función por celda de CE.1.6. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await require('./20261112135447_ce16_erp_unit_cost_por_celda.js').up(knex);
  await knex.raw(`DROP FUNCTION IF EXISTS ${NUEVA}`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_ficha_cost`);
};

// Para el ensayo y la prueba de la spec: el mismo texto que corre el `up`.
exports.SQL = { FICHA, RESOLVE, ERP_COMPLETA, POR_CELDA };
