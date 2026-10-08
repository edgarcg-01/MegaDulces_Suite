'use strict';
/**
 * `[IC.21.1]` — LA VISTA DE CAPITAL EN PROD LEE LA FUENTE LENTA, Y NADIE LA IBA A ARREGLAR.
 *
 * ── Qué pasó, para que no se repita ─────────────────────────────────────────────────────────
 *
 * `20261007131819_v_abc_capital.js` se aplicó a prod el 2026-10-07 a las 15:36 leyendo
 * `analytics.v_erp_unit_cost` (la VISTA). A las 15:43 el PR #302 corrigió ese mismo archivo para
 * que leyera `analytics.mv_erp_unit_cost` (la MATVISTA) — pero **editó una migración que ya
 * estaba aplicada**, y knex no vuelve a correr un archivo cuyo nombre ya figura en
 * `knex_migrations`.
 *
 * ⛔ O sea: el repo quedó correcto y **prod quedó con la definición lenta, para siempre**.
 *
 * ⭐ **La lección es de proceso, no de SQL:** corregir una migración editándola sólo sirve
 * mientras no se haya aplicado en ningún lado. En cuanto tocó un entorno, el arreglo necesita
 * una migración NUEVA — si no, el repo y prod divergen **en silencio**, y ninguna prueba lo nota
 * porque cada lado se ve sano por separado.
 *
 * ── Lo medido antes de escribir esto (prod, 2026-10-07, sólo lectura) ───────────────────────
 *  · `pg_get_viewdef` en prod referencia `v_erp_unit_cost` → confirmado, quedó la lenta
 *  · `analytics.mv_erp_unit_cost` **sí existe** en prod → el arreglo es aplicable
 *  · leer UN almacén (03) con la definición lenta: **1,946 ms** para 2,919 filas
 *  · la validación de la migración original tardó **8 minutos** sosteniendo el candado global
 *    de migraciones, con un backfill del ODS escribiendo en paralelo
 *
 * ── Por qué la guarda de acá es BARATA, a propósito ─────────────────────────────────────────
 *
 * ⛔ La migración original barría la vista ENTERA (9 almacenes) dentro de su transacción, con el
 * candado tomado. **Una guarda de migración no puede costar lo que cuesta la pantalla**: lo que
 * afuera son 2 s, adentro de una transacción larga y con escrituras concurrentes fueron 8 min.
 *
 * Acá la guarda se acota a **un solo almacén** — el delator sigue valiendo, porque el Pareto se
 * calcula por almacén y uno siempre produce clase B — y las aserciones sobre la población
 * completa viven en `database/tests/test-newdb-abc-capital.js`, que corre **fuera** de todo
 * candado.
 *
 * ⚠️ `security_invoker` y el `GRANT` se re-aplican: un `CREATE OR REPLACE VIEW` **no los hereda**
 * (lección U.7), y acá se verifica en metadata antes de dar por buena la corrida.
 *
 * Idempotente: si la vista ya lee la matvista, no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const CUERPO = `
WITH base AS (
  SELECT s.tenant_id,
         s.warehouse_id,
         s.warehouse_code,
         s.product_id,
         s.sku,
         s.qty_stock_units                        AS on_hand,
         uc.costo_unitario,
         CASE WHEN uc.costo_unitario > 0
              THEN (s.qty_stock_units * uc.costo_unitario)::numeric(16,2)
         END                                      AS capital,
         uc.costo_source,
         uc.tiene_testigo,
         uc.veredicto                             AS costo_veredicto
    FROM analytics.v_erp_stock_on_hand s
    LEFT JOIN analytics.mv_erp_unit_cost uc
           ON uc.tenant_id    = s.tenant_id
          AND uc.warehouse_id = s.warehouse_id
          AND uc.product_id   = s.product_id
   WHERE s.qty_stock_units > 0
), ranked AS (
  SELECT b.*,
         sum(b.capital) OVER (
           PARTITION BY b.tenant_id, b.warehouse_id
           ORDER BY b.capital DESC NULLS LAST, b.product_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)       AS cum_capital,
         NULLIF(sum(b.capital) OVER (
           PARTITION BY b.tenant_id, b.warehouse_id), 0)           AS total_capital,
         row_number() OVER (
           PARTITION BY b.tenant_id, b.warehouse_id
           ORDER BY b.capital DESC NULLS LAST, b.product_id)       AS rango_almacen,
         count(*) OVER (PARTITION BY b.tenant_id, b.warehouse_id)  AS skus_en_almacen
    FROM base b
)
SELECT tenant_id,
       warehouse_id,
       warehouse_code,
       product_id,
       sku,
       on_hand,
       costo_unitario,
       capital,
       CASE
         WHEN capital IS NULL       THEN NULL
         WHEN total_capital IS NULL THEN 'C'
         WHEN ((cum_capital - capital) / total_capital) < 0.80 THEN 'A'
         WHEN ((cum_capital - capital) / total_capital) < 0.95 THEN 'B'
         ELSE 'C'
       END AS capital_class,
       CASE
         WHEN costo_unitario IS NULL OR costo_unitario <= 0 THEN 'sin_costo'
         WHEN total_capital IS NULL                         THEN 'almacen_sin_capital'
         ELSE 'pareto'
       END AS clase_motivo,
       CASE WHEN total_capital IS NOT NULL AND capital IS NOT NULL
            THEN round(cum_capital / total_capital, 4) END AS value_share,
       CASE WHEN total_capital IS NOT NULL AND capital IS NOT NULL
            THEN round(capital / total_capital, 6) END     AS aporte_individual,
       rango_almacen,
       skus_en_almacen,
       costo_source,
       tiene_testigo,
       costo_veredicto
  FROM ranked`;

const LEE_MATVISTA = `SELECT pg_get_viewdef('analytics.v_abc_capital'::regclass, true)
                             LIKE '%mv_erp_unit_cost%' AS si`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if ((await knex.raw(LEE_MATVISTA)).rows[0].si) {
    console.log('  [abc-capital] la vista ya lee la matvista — nada que hacer');
    return;
  }

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_abc_capital AS ${CUERPO}`);
  await knex.raw(`ALTER VIEW analytics.v_abc_capital SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_abc_capital TO app_runtime`);

  if (!(await knex.raw(LEE_MATVISTA)).rows[0].si) {
    throw new Error('la vista sigue leyendo v_erp_unit_cost: el reemplazo no tomo');
  }

  const opts = (await knex.raw(
    `SELECT unnest(c.reloptions) AS o
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_abc_capital'`)).rows.map((r) => r.o);
  if (!opts.some((x) => String(x).includes('security_invoker'))) {
    throw new Error('v_abc_capital perdio security_invoker');
  }

  // Guarda ACOTADA a un almacen: el Pareto se calcula por almacen, asi que el delator
  // (siempre hay clase B) vale igual, y no se barre la poblacion entera con el candado tomado.
  const [{ code }] = (await knex.raw(
    `SELECT warehouse_code AS code FROM analytics.v_abc_capital
      WHERE warehouse_code IS NOT NULL ORDER BY warehouse_code LIMIT 1`)).rows;
  const d = (await knex.raw(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE capital_class = 'A')::int AS a,
            count(*) FILTER (WHERE capital_class = 'B')::int AS b,
            count(*) FILTER (WHERE capital_class = 'C')::int AS c
       FROM analytics.v_abc_capital WHERE warehouse_code = ?`, [code])).rows[0];
  if (d.b < 1) throw new Error(`almacen ${code}: clase B = 0 — un Pareto siempre produce B`);
  if (d.a < 1) throw new Error(`almacen ${code}: clase A = 0 — la fuente esta vacia`);

  console.log(`  [abc-capital] ahora lee mv_erp_unit_cost · guarda en almacen ${code}:`
    + ` ${d.total} filas · A ${d.a} · B ${d.b} · C ${d.c}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista vuelve a leer la VISTA lenta. */
exports.down = async function down(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_abc_capital AS `
    + CUERPO.replace(/mv_erp_unit_cost/g, 'v_erp_unit_cost'));
  await knex.raw(`ALTER VIEW analytics.v_abc_capital SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_abc_capital TO app_runtime`);
};
