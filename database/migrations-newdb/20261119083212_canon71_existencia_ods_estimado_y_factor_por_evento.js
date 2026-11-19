'use strict';
/**
 * `[CANON.7.1]` — **La existencia del ODS se puede leer directo: la vista tardaba por un ESTIMADO, no por RLS.**
 *
 * Para retirar `commercial.stock` (la copia que escribe `import-branch-stock-live` cada 15 min) los lectores tienen que
 * poder leer `analytics.v_erp_stock_on_hand`. Medida como la vive la app (rol sin superusuario ni BYPASSRLS), una
 * sucursal tardaba 10.5–14 s. El anexo CANON.7 (2026-11-18) proponía por eso una tabla nueva mantenida por evento. No
 * hace falta: la vista tarda por dos cosas medibles, y las dos se arreglan sin copiar nada.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-19, rol `edgar` sin BYPASSRLS) ──
 *  1. ⭐ **El estimado de `kdil`.** El filtro `k.sucursal = k.c1` (el almacén propio de cada sucursal) compara dos
 *     columnas, y Postgres no tiene estadística para eso: usa el 0.5 % por defecto. Estima **204** filas; son
 *     **37,133** de 40,800 (91 %). Con 204 elige un Merge Join sólo por almacén y deja el SKU como filtro: **40 millones
 *     de pares descartados**, 13.8 s de 13.8 s. Reproducido en un Postgres 18 desechable con datos sintéticos de la
 *     misma forma: sin estadística, 204 (igual que prod); con `CREATE STATISTICS … ON ((sucursal = c1))` y el filtro
 *     escrito `(…) IS TRUE`, **37,123**. ⚠️ Escrito sin `IS TRUE` sigue en 204: la estadística de expresión sólo la usa
 *     el planificador cuando la expresión aparece como tal (y un MCV de las dos columnas tampoco sirve, probado).
 *     Reescribirlo como unión al almacén por `sucursal` Y `c1` NO sirve: la clase de equivalencia vuelve a derivar
 *     `sucursal = c1` (mismo plan, 12.9 s, medido).
 *  2. **El factor de caja.** `v_product_box_factor` se calcula entero (10 mil productos) en cada lectura: ~330 ms aun
 *     con el estimado bien. `[CANON.6.21]` ya guarda esa misma regla por llave en `analytics.resolved_product_box_factor`
 *     (la escribe sólo `recalcular_existencia`, por evento, encendida desde el 2026-11-17).
 *
 *     Con el estimado de (1) simulado y el factor de (2):  una sucursal 36–66 ms · toda la red 87–113 ms ·
 *     3 SKUs 5–6 ms (antes 10.5–14 s · ~1 s · ~1.1 s).
 *
 * Lo que cambia, y nada más (el texto nuevo se arma sobre el viejo con reemplazos que exigen aparecer UNA vez):
 *   · `kepler_ods.st_kdil_almacen_propio` — estadística de la expresión `(sucursal = c1)` en `kdil`, y `ANALYZE`
 *     (40 mil filas, <1 s). La mantiene el autoanalyze como cualquier estadística: no es un reloj nuestro.
 *   · La vista: `WHERE (k.sucursal = k.c1) IS TRUE` (mismo resultado: un NULL ya quedaba fuera del WHERE) y el factor
 *     de caja de las dos piernas desde `analytics.resolved_product_box_factor` (mismas columnas, mismo tipo `numeric`).
 *
 * ── ⛔ Lo que difiere, declarado ───────────────────────────────────────────────────────────────────────────────────
 *  · La CANTIDAD no cambia (misma fórmula, mismas filas): la prueba lo exige al centavo contra el texto anterior.
 *  · `display_box_factor`: hoy difiere en **3 SKUs** (21086, 78288, 95912: la vista dice 12/27 por etiquetera o
 *    `factor_sale`, la tabla 1 por `kepler_peldano_comprado`). Las dos leen la misma matvista `mv_kepler_bought_rung`
 *    (refresco NOCTURNO de `AnalyticsRefreshService`, un reloj): la vista la ve al refrescarse, la tabla hasta su
 *    recálculo completo del día siguiente (00:02 de México), porque un `REFRESH` no dispara la cola. Hueco de
 *    `[CANON.6.21]` con nombre: el peldaño comprado como fuente por evento; hasta entonces el retraso es < 24 h.
 *
 * ⚠️ `CREATE OR REPLACE VIEW` toma ACCESS EXCLUSIVE sobre la vista hasta el COMMIT (frena a sus lectores) y no hereda
 *    `security_invoker` ni los GRANT (ADR-057): se re-aplican. La vista va AL FINAL, después del ANALYZE, para que ese
 *    candado dure milisegundos. Una lectura de 10 s en curso (las de hoy) la hace esperar: `lock_timeout` 5 s y, si no
 *    lo obtiene, falla entera sin dejar nada. Fuera de horario, y antes mirar `pg_stat_activity`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const ESTADISTICA = 'kepler_ods.st_kdil_almacen_propio';
const FACTOR_POR_EVENTO = 'analytics.resolved_product_box_factor';

/** La vista tal como la dejó `20261001190000_cedis_arbitrado_por_corte` (letra por letra; el `down` vuelve a ella). */
const SQL_ANTERIOR = `
CREATE OR REPLACE VIEW analytics.v_erp_stock_on_hand AS
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(k.c4 + k.c8 - k.c9), 0::double precision)::numeric AS qty_stock_units,
    GREATEST(COALESCE(max(bfx.box_factor), 1::numeric), 1::numeric) AS display_box_factor,
    'kepler'::text AS unit_source,
    'kepler_ods'::text AS source
   FROM kepler_ods.kdil k
     JOIN commercial.warehouses w
       ON w.kepler_code = k.sucursal
      AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = w.tenant_id AND pr.sku::text = btrim(k.c3) AND pr.deleted_at IS NULL
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE k.sucursal = k.c1
    AND (btrim(k.c3) <> ALL (ARRAY['00001'::text, '00002'::text, '00022'::text]))
    -- Sólo la rama 00 lleva el filtro de corte, porque es la única ARBITRADA (reporte de
    -- existencia del ERP, 9,496 SKUs, 01-10-2026). Subconsulta NO correlacionada: se evalúa una
    -- vez y no puede multiplicar filas. Si devuelve NULL el predicado es NULL y la 00 no publica.
    AND (w.kepler_code <> '00'::text
         OR GREATEST(k.c6, k.c7)::date >= (SELECT min(c.cutover_date)
                                             FROM analytics.v_branch_erp_cutover c
                                            WHERE c.kepler_code = '00'::text))
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
UNION ALL
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(v.existencia), 0::numeric) AS qty_stock_units,
    GREATEST(COALESCE(max(CASE WHEN a.factor_venta > 1::numeric THEN a.factor_venta
                               ELSE NULL::numeric END), max(bfx.box_factor), 1::numeric),
             1::numeric) AS display_box_factor,
    CASE WHEN max(CASE WHEN a.factor_venta > 1::numeric THEN 1 ELSE 0 END) = 1
         THEN 'wincaja_multipack'::text ELSE 'wincaja'::text END AS unit_source,
    'wincaja'::text AS source
   FROM wincaja.v_stock v
     JOIN commercial.warehouses w
       ON w.tenant_id = v.tenant_id AND w.wincaja_source_branch = v.source_branch
      AND w.kepler_code IS NULL AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = v.tenant_id AND pr.sku::text = v.sku AND pr.deleted_at IS NULL
     LEFT JOIN wincaja.articulos a
       ON a.tenant_id = v.tenant_id AND a.articulo = v.sku
      AND a.source_branch = v.source_branch AND a.source_dataset = 'actual'::text
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE v.existencia IS NOT NULL AND v.warehouse_code NOT LIKE 'RUTA-%'
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`;

/** Reemplaza `a` por `b` exigiendo que `a` aparezca exactamente `n` veces: un cambio de más o de menos truena aquí. */
function exacto(texto, a, b, n = 1) {
  const veces = texto.split(a).length - 1;
  if (veces !== n) throw new Error(`[CANON.7.1] «${a.slice(0, 60)}…» aparece ${veces} veces (se esperaban ${n})`);
  return texto.split(a).join(b);
}

/** La vista nueva: el texto anterior con SÓLO el filtro reescrito y el factor de caja desde la tabla por evento. */
const SQL = exacto(
  exacto(SQL_ANTERIOR,
    '  WHERE k.sucursal = k.c1\n',
    `  -- [CANON.7.1] Escrito como expresión para que el planificador use ${ESTADISTICA}: comparado como dos
  -- columnas estimaba 204 filas de 37 mil y la vista tardaba 11 s por sucursal. Un NULL queda fuera igual que antes.
  WHERE (k.sucursal = k.c1) IS TRUE\n`),
  'LEFT JOIN analytics.v_product_box_factor bfx',
  `LEFT JOIN ${FACTOR_POR_EVENTO} bfx`,
  2);

async function aplicar(knex, sql) {
  await knex.raw(sql);
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_on_hand SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO dev_ro`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [r] } = await knex.raw(`SELECT to_regclass('kepler_ods.kdil') IS NOT NULL AS kdil,
                                               to_regclass('${FACTOR_POR_EVENTO}') IS NOT NULL AS factor`);
  if (!r.kdil) throw new Error('[CANON.7.1] falta kepler_ods.kdil');
  if (!r.factor) throw new Error(`[CANON.7.1] falta ${FACTOR_POR_EVENTO} (la crea 20261117085622, [CANON.6.21])`);

  // 1. La estadística y su primer cálculo (ShareUpdateExclusive: no frena lecturas ni escrituras de la ingesta).
  await knex.raw(`CREATE STATISTICS IF NOT EXISTS ${ESTADISTICA} ON ((sucursal = c1)) FROM kepler_ods.kdil`);
  await knex.raw(`COMMENT ON STATISTICS ${ESTADISTICA} IS
    '[CANON.7.1] Cuántas filas de kdil son del almacén propio de su sucursal (sucursal = c1; medido 91 %). Sin ella el '
    'planificador estima 0.5 % y analytics.v_erp_stock_on_hand tarda 11 s por sucursal. La vista escribe el filtro '
    '(k.sucursal = k.c1) IS TRUE para que se use: no cambiar uno sin el otro.'`);
  await knex.raw(`ANALYZE kepler_ods.kdil`);

  // 2. La vista, al final: su ACCESS EXCLUSIVE dura hasta el COMMIT, que queda inmediatamente detrás.
  await aplicar(knex, SQL);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await aplicar(knex, SQL_ANTERIOR);
  await knex.raw(`DROP STATISTICS IF EXISTS ${ESTADISTICA}`);
};

exports.SQL = SQL;
exports.SQL_ANTERIOR = SQL_ANTERIOR;
exports.ESTADISTICA = ESTADISTICA;
