'use strict';
/**
 * `[CANON.6.1]` — `analytics.v_pos_cashiers`: el catálogo de cajeros y gerentes del POS de Kepler, leído
 * del ODS (derive-no-copy). Reemplaza al importer `import-pos-cashiers.js` y a su tabla
 * `analytics.pos_cashiers` (Edgar, 2026-11-10: «ningún importer y ningún cron»; 2026-11-11: «hay que
 * erradicarlos»). La tabla vieja NO se toca: queda congelada; su borrado se pide aparte (regla 5).
 *
 * La misma regla que el importer (`readOds`): `kdpv_kdku` (c1 clave, c2 nombre) y `kdpv_gerentes` de
 * su PROPIA sucursal (c1 = sucursal; c2 clave, c3 nombre); en un código compartido gana el gerente
 * (el importer lo cargaba después y su UPSERT lo pisaba). Texto limpio como `clean()`: tabuladores y
 * saltos de línea a un espacio, sin espacios en los extremos. `warehouse_id` como `loadWarehouseMap`:
 * por `kepler_code` y, si no, por `code`.
 *
 * ── Lo medido antes (sólo lectura, prod) ────────────────────────────────────────────────────
 *  · ver `[CANON.6.1]` en el tracker: filas de la tabla contra la vista, y las diferencias una por una.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

const VISTA = String.raw`
WITH f AS (
  SELECT k.sucursal AS warehouse_code,
         btrim(regexp_replace(k.c1, '[\r\n\t]+', ' ', 'g')) AS cajero_code,
         btrim(regexp_replace(k.c2, '[\r\n\t]+', ' ', 'g')) AS nombre,
         'cajero'::text AS source, 1 AS orden
    FROM kepler_ods.kdpv_kdku k
  UNION ALL
  SELECT g.sucursal,
         btrim(regexp_replace(g.c2, '[\r\n\t]+', ' ', 'g')),
         btrim(regexp_replace(g.c3, '[\r\n\t]+', ' ', 'g')),
         'gerente'::text, 2
    FROM kepler_ods.kdpv_gerentes g
   WHERE g.c1 = g.sucursal
)
SELECT DISTINCT ON (f.warehouse_code, f.cajero_code)
       '${T}'::uuid AS tenant_id,
       f.warehouse_code, f.cajero_code, f.nombre, f.source,
       (SELECT w.id FROM commercial.warehouses w
         WHERE w.tenant_id = '${T}'::uuid AND w.deleted_at IS NULL
           AND (btrim(w.kepler_code) = f.warehouse_code OR btrim(w.code) = f.warehouse_code)
         ORDER BY (btrim(w.kepler_code) = f.warehouse_code) DESC NULLS LAST
         LIMIT 1) AS warehouse_id
  FROM f
 WHERE f.cajero_code <> '' AND f.nombre <> ''
 ORDER BY f.warehouse_code, f.cajero_code, f.orden DESC
`;

exports.VISTA = VISTA;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_pos_cashiers AS ` + VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_pos_cashiers IS '[CANON.6.1] Cajeros (kdpv_kdku) y gerentes de su sucursal (kdpv_gerentes) del POS de Kepler, desde kepler_ods; en codigo compartido gana el gerente. Reemplaza al importer import-pos-cashiers.js y a analytics.pos_cashiers (congelada).'`);
  await knex.raw(`GRANT SELECT ON analytics.v_pos_cashiers TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    EXECUTE 'GRANT SELECT ON analytics.v_pos_cashiers TO dev_ro'; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_pos_cashiers`);
};
