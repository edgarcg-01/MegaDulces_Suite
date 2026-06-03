/**
 * Backfill: re-vincular las rutas a su zona.
 *
 * Las rutas (catalog_id='rutas') quedaron con `parent_id = NULL` tras la
 * migración legacy→newdb: `migrate-legacy-to-newdb.js::migrateCatalogs` setea
 * parent_id a null cuando el parent no existe en `catalogs`, pero las rutas
 * apuntaban a la tabla `zones` (no a catalogs) → se perdió el link.
 *
 * Recuperado de la DB legacy (`trade_marketing_respaldo`): las 7 rutas
 * (RUTA 21–29) pertenecen todas a la zona **LA PIEDAD RD**. Confirmado por el
 * usuario 2026-06-03.
 *
 * Idempotente: solo toca rutas con parent_id NULL. Lookup de zona por nombre
 * dentro del mismo tenant (no hardcodea UUID).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const res = await knex.raw(`
    UPDATE public.catalogs c
    SET parent_id = z.id
    FROM public.zones z
    WHERE c.catalog_id = 'rutas'
      AND c.parent_id IS NULL
      AND z.tenant_id = c.tenant_id
      AND z.name = 'LA PIEDAD RD'
      AND z.deleted_at IS NULL
  `);
  console.log(`  ✓ rutas re-vinculadas a LA PIEDAD RD: ${res.rowCount}`);
};

/**
 * No revertimos: dejar rutas sin zona de nuevo no aporta y el estado previo
 * (NULL) era el bug. No-op seguro.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // intencionalmente vacío
};
