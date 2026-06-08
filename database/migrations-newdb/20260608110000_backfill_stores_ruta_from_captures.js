/**
 * Backfill: deriva `stores.ruta_id` de la ruta que los vendedores declararon al
 * visitar la tienda (daily_captures.route_id). En prod las tiendas no tenían
 * ruta asignada (stores.ruta_id NULL) pero las capturas sí traen route_id (ruta
 * self-service de /captures); sin este link el apartado "Rutas" (que agrupa por
 * stores.ruta_id, igual que /reports/routes) no muestra nada.
 *
 * Regla: por tienda, la ruta con MÁS capturas (tiebreak: la más reciente).
 * Idempotente: solo asigna donde ruta_id IS NULL (no pisa asignaciones manuales).
 * Multi-tenant safe: store_id/route_id son UUID únicos; valida que route_id sea
 * un catálogo 'rutas' vigente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const res = await knex.raw(`
    UPDATE stores s
       SET ruta_id = sub.route_id, updated_at = NOW()
      FROM (
        SELECT store_id, route_id FROM (
          SELECT dc.store_id, dc.route_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY dc.store_id
                   ORDER BY COUNT(*) DESC, MAX(dc.created_at) DESC
                 ) AS rn
            FROM daily_captures dc
           WHERE dc.route_id IS NOT NULL AND dc.store_id IS NOT NULL
           GROUP BY dc.store_id, dc.route_id
        ) ranked
        WHERE rn = 1
      ) sub
     WHERE s.id = sub.store_id
       AND s.ruta_id IS NULL
       AND s.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM catalogs c
          WHERE c.id = sub.route_id AND c.catalog_id = 'rutas' AND c.deleted_at IS NULL
       )
  `);
  console.log(`[backfill_stores_ruta_from_captures] ${res.rowCount ?? 0} tienda(s) ligadas a su ruta.`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: no sabemos cuáles eran NULL originalmente; revertir borraría
  // asignaciones legítimas.
  console.log('[backfill_stores_ruta_from_captures] down: no-op');
};
