/**
 * Backfill: asigna la zona LA PIEDAD RD a las tiendas de Mega Dulces que no
 * tienen zona (stores.zona_id NULL). Hecho operativo confirmado por el usuario:
 * todas las tiendas actuales pertenecen a La Piedad. Habilita el filtro por zona
 * en reportes/apartado Rutas y deja la jerarquía zona→ruta→tienda consistente.
 *
 * Scoped a Mega Dulces (La Piedad es de este tenant; NO tocar otros tenants).
 * Idempotente: solo donde zona_id IS NULL. FK compuesta (tenant_id, zona_id)
 * se satisface porque la zona es del mismo tenant.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const T = '00000000-0000-0000-0000-00000000d01c';
  const zone = await knex('zones')
    .where({ tenant_id: T })
    .whereRaw("UPPER(name) = 'LA PIEDAD RD'")
    .whereNull('deleted_at')
    .first();
  if (!zone) {
    console.log('[backfill_stores_zona_la_piedad] zona LA PIEDAD RD no existe para el tenant; skip.');
    return;
  }
  const res = await knex('stores')
    .where({ tenant_id: T })
    .whereNull('zona_id')
    .whereNull('deleted_at')
    .update({ zona_id: zone.id, updated_at: knex.fn.now() });
  console.log(`[backfill_stores_zona_la_piedad] ${res} tienda(s) asignadas a LA PIEDAD RD.`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: no sabemos cuáles eran NULL originalmente.
  console.log('[backfill_stores_zona_la_piedad] down: no-op');
};
