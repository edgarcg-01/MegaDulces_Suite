'use strict';
/**
 * `[CANON.6.3]` — `analytics.v_pos_ticket_sales`: la venta atómica de tickets del POS de Kepler
 * (`kdm1` U-D-10) por sucursal × cajero (`c67`) × día (`c9`), leída del ODS (derive-no-copy). Es la capa
 * que el motor de conciliación compara contra el corte (regla `venta_vs_tickets`). Reemplaza al importer
 * `import-pos-ticket-sales.js` y a su tabla `analytics.pos_ticket_sales` (Edgar, 2026-11-10: «ningún
 * importer y ningún cron»; 2026-11-11: «hay que erradicarlos»). La tabla vieja NO se toca: queda
 * congelada; su borrado se pide aparte (regla 5).
 *
 * La misma consulta que el importer (`readOds`): documentos propios (`c1 = sucursal`), venta U-D-10,
 * cajero no vacío; cuenta de tickets y Σ `c16` redondeada a centavos. El cajero, sin espacios en los
 * extremos (el importer lo recortaba al guardar).
 *
 * ── Lo medido antes (sólo lectura, prod) ────────────────────────────────────────────────────
 *  · ver `[CANON.6.3]` en el tracker.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

const VISTA = String.raw`
WITH w AS (
  SELECT DISTINCT ON (x.k) x.k, x.id
    FROM (SELECT btrim(kepler_code) AS k, id, 1 AS pri FROM commercial.warehouses
           WHERE tenant_id = '${T}'::uuid AND deleted_at IS NULL AND kepler_code IS NOT NULL
          UNION ALL
          SELECT btrim(code), id, 2 FROM commercial.warehouses
           WHERE tenant_id = '${T}'::uuid AND deleted_at IS NULL AND code IS NOT NULL) x
   ORDER BY x.k, x.pri
)
SELECT '${T}'::uuid AS tenant_id,
       m.sucursal AS warehouse_code,
       w.id AS warehouse_id,
       btrim(m.c67) AS cajero_code,
       m.c9::date AS business_date,
       count(*)::int AS ticket_count,
       round(sum(m.c16), 2) AS ticket_total
  FROM kepler_ods.kdm1 m
  LEFT JOIN w ON w.k = m.sucursal
 WHERE m.c2 = 'U' AND m.c3 = 'D' AND m.c4 = 10
   AND m.c1 = m.sucursal
   AND btrim(COALESCE(m.c67, '')) <> ''
 GROUP BY m.sucursal, w.id, btrim(m.c67), m.c9::date
`;

exports.VISTA = VISTA;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_pos_ticket_sales AS ` + VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_pos_ticket_sales IS '[CANON.6.3] Venta de tickets del POS de Kepler (kdm1 U-D-10) por sucursal, cajero (c67) y dia (c9), desde kepler_ods. Reemplaza al importer import-pos-ticket-sales.js y a analytics.pos_ticket_sales (congelada).'`);
  await knex.raw(`GRANT SELECT ON analytics.v_pos_ticket_sales TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    EXECUTE 'GRANT SELECT ON analytics.v_pos_ticket_sales TO dev_ro'; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_pos_ticket_sales`);
};
