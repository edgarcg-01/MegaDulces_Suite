'use strict';
/**
 * `[VEX.9]` — `analytics.v_cash_sessions`: las sesiones de caja leídas del ODS de Kepler
 * (`kepler_ods.kdpv_folio_caja`), para retirar `import-cash-sessions` (anexo CANON §3.3: «VISTA»).
 *
 * POR QUÉ: `/tienda/cajas` (`store.service`) es el único lector de `analytics.cash_sessions`, una
 * tabla que el importer llena cada 30 min por UPSERT sin borrar nunca. La vista es fresca sin
 * mantenimiento (la alimenta el carril `ods_live_hot`). Se crea con OTRO nombre: la tabla queda sin
 * lector ni escritor y su borrado espera la decisión D2 del anexo, como `purchase_velocity`.
 *
 * Dos defectos de la tabla que la vista no hereda:
 *  · La llave del importer era (sucursal, caja, folio), pero en Kepler el folio se repite entre
 *    puntos de venta: la llave real es (sucursal, c1, c2, c3). La tabla PISABA sesiones (la
 *    `01` caja 1 folio 129 son tres sesiones distintas; quedaba la última escrita).
 *  · `c1` es el punto de venta. En la `01` el mismo libro trae las sesiones de sus camionetas
 *    (`c1` = 01-001…01-006 = RUTA-21…RUTA-28); el importer no filtraba `c1` y el monitor de la
 *    tienda las mostraba como «caja 1/2». La vista expone `punto_venta` y `es_tienda`, y resuelve
 *    el almacén por `kepler_code = c1` (tienda o camioneta, con su nombre).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-06) ────────────────────────────────────────
 *  · Abiertas en la ventana de 2 días: tabla 24; vista (todas) 24, idénticas por
 *    (sucursal, caja, folio, estado, cajero, apertura, cierre) — 0 y 0 con EXCEPT ALL; control
 *    negativo (3 días contra 2) = 42.
 *  · Con `es_tienda`: 23. La que sale es la camioneta Ruta 26 (caja 2, folio 7, 26VGHG).
 *  · 5,680 filas, 0 sin almacén, llave (sucursal, punto_venta, caja, folio) única. 19 ms.
 *  · La `03` se nombra «8 Esquinas» (de `commercial.warehouses`), no «8ESQ».
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
       btrim(f.sucursal) AS warehouse_code,
       COALESCE(w.name, 'Sucursal ' || btrim(f.sucursal)) AS warehouse_name,
       w.id AS warehouse_id,
       btrim(f.c1) AS punto_venta,
       (btrim(f.c1) = btrim(f.sucursal)) AS es_tienda,
       btrim(f.c2) AS caja,
       f.c3::text AS folio,
       f.c5::date AS business_date,
       COALESCE(NULLIF(btrim(f.c8), ''), NULLIF(btrim(f.c7), '')) AS cajero_code,
       ((f.c5::date + COALESCE(NULLIF(btrim(f.c6), '')::time, '00:00'::time)) AT TIME ZONE 'America/Mexico_City') AS opened_at,
       CASE WHEN f.c10 IS NULL OR f.c10::text LIKE '1800-%' THEN NULL
            ELSE (f.c10 AT TIME ZONE 'America/Mexico_City') END AS closed_at,
       CASE WHEN f.c10 IS NULL OR f.c10::text LIKE '1800-%' THEN 'open' ELSE 'closed' END AS status,
       'kepler_ods'::text AS source
  FROM kepler_ods.kdpv_folio_caja f
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND w.kepler_code = btrim(f.c1)
   AND w.deleted_at IS NULL`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_cash_sessions AS ` + VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_cash_sessions IS '[VEX.9] Sesiones de caja de Kepler (kdpv_folio_caja) desde el ODS. es_tienda separa las cajas de la tienda de las de sus camionetas (c1). Reemplaza a analytics.cash_sessions (import-cash-sessions).'`);
  await knex.raw(`GRANT SELECT ON analytics.v_cash_sessions TO app_runtime`);
  // dev_ro existe en prod, no necesariamente en la base del CI.
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    EXECUTE 'GRANT SELECT ON analytics.v_cash_sessions TO dev_ro'; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista nueva (la tabla vieja no se tocó). */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_cash_sessions`);
};
