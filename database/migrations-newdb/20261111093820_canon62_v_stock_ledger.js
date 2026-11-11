'use strict';
/**
 * `[CANON.6.2]` — `analytics.v_stock_ledger`: los movimientos de inventario de género N (ajustes,
 * mermas, traspasos, inventario físico) del kardex de Kepler, leídos del ODS (derive-no-copy).
 * Reemplaza al importer `import-kardex.js` y a su tabla `analytics.stock_ledger` (Edgar, 2026-11-10:
 * «ningún importer y ningún cron»; 2026-11-11: «hay que erradicarlos»). La tabla vieja NO se toca:
 * queda congelada; su borrado se pide aparte (regla 5).
 *
 * La misma regla que el importer (`readOds` + `dedupeAggregate` + `claseMov`):
 *   · `kdij` de la sucursal propia (`c1 = sucursal`), sólo `c4 = 'N'`.
 *   · una fila por (sucursal, folio, género, naturaleza, grupo, sku), SUMANDO unidades e importe de
 *     sus renglones (el importe de cada renglón en valor absoluto: `c13`, o `c21` si `c13` es 0).
 *   · clase_mov: D+grupo 5 merma · D+6/25 traspaso_salida · D otro ajuste_salida · A+6/25
 *     traspaso_entrada · A+20 ajuste_entrada · A+30..45 inv_fisico · lo demás otro.
 *   · `id`: la llave hecha uuid (md5), estable entre consultas — la pantalla de movimientos lo usa
 *     como llave de fila.
 * Lo que el importer NO hacía y la vista sí, por construcción: un movimiento que Kepler cancela y
 * borra del kardex desaparece aquí (el UPSERT nunca borraba; ver `[CANON.5.29]`).
 *
 * Su velocidad depende del índice parcial `ix_kdij_genero_n` (migración `20261111093819`): sin él,
 * cada consulta recorre las 2.1 M filas de `kdij` (~1.4 s).
 *
 * ── Lo medido antes (sólo lectura, prod) ────────────────────────────────────────────────────
 *  · ver `[CANON.6.2]` en el tracker.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

const VISTA = String.raw`
WITH k AS (
  SELECT j.sucursal,
         NULLIF(btrim(j.c19), '') AS almacen,
         btrim(j.c3) AS sku,
         j.c4 AS genero,
         j.c5 AS naturaleza,
         NULLIF(btrim(j.c6::text), '') AS grupo,
         btrim(j.c8) AS folio,
         COALESCE(j.c9, 0) AS unidades,
         NULLIF(btrim(j.c12), '') AS unidad,
         abs(COALESCE(NULLIF(j.c13, 0), j.c21::numeric, 0)) AS importe,
         j.c10::date AS fecha
    FROM kepler_ods.kdij j
   WHERE j.c4 = 'N' AND j.c1 = j.sucursal
),
w AS (
  SELECT DISTINCT ON (x.k) x.k, x.id
    FROM (SELECT btrim(kepler_code) AS k, id, 1 AS pri FROM commercial.warehouses
           WHERE tenant_id = '${T}'::uuid AND deleted_at IS NULL AND kepler_code IS NOT NULL
          UNION ALL
          SELECT btrim(code), id, 2 FROM commercial.warehouses
           WHERE tenant_id = '${T}'::uuid AND deleted_at IS NULL AND code IS NOT NULL) x
   ORDER BY x.k, x.pri
)
SELECT md5(concat_ws('|', k.sucursal, k.folio, k.genero, k.naturaleza, COALESCE(k.grupo, '-'), k.sku))::uuid AS id,
       '${T}'::uuid AS tenant_id,
       k.sucursal AS warehouse_code,
       w.id AS warehouse_id,
       min(k.almacen) AS almacen,
       k.sku, k.genero, k.naturaleza, k.grupo,
       CASE
         WHEN k.naturaleza = 'D' AND k.grupo = '5' THEN 'merma'
         WHEN k.naturaleza = 'D' AND k.grupo IN ('6', '25') THEN 'traspaso_salida'
         WHEN k.naturaleza = 'D' THEN 'ajuste_salida'
         WHEN k.naturaleza = 'A' AND k.grupo IN ('6', '25') THEN 'traspaso_entrada'
         WHEN k.naturaleza = 'A' AND k.grupo = '20' THEN 'ajuste_entrada'
         WHEN k.naturaleza = 'A' AND k.grupo ~ '^[0-9]+$' AND k.grupo::int BETWEEN 30 AND 45 THEN 'inv_fisico'
         ELSE 'otro'
       END AS clase_mov,
       k.folio,
       sum(k.unidades) AS unidades,
       min(k.unidad) AS unidad,
       sum(k.importe) AS importe,
       max(k.fecha) AS fecha,
       'kepler'::text AS source
  FROM k
  LEFT JOIN w ON w.k = k.sucursal
 GROUP BY k.sucursal, w.id, k.folio, k.genero, k.naturaleza, k.grupo, k.sku
`;

exports.VISTA = VISTA;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_stock_ledger AS ` + VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_stock_ledger IS '[CANON.6.2] Movimientos de inventario genero N (ajustes, mermas, traspasos, inventario fisico) del kardex de Kepler (kepler_ods.kdij), una fila por sucursal-folio-genero-naturaleza-grupo-sku. Reemplaza al importer import-kardex.js y a analytics.stock_ledger (congelada).'`);
  await knex.raw(`GRANT SELECT ON analytics.v_stock_ledger TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    EXECUTE 'GRANT SELECT ON analytics.v_stock_ledger TO dev_ro'; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_stock_ledger`);
};
