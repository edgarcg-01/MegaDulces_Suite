/**
 * Backfill: garantiza COMMERCIAL_WAREHOUSES_VER + COMMERCIAL_PROMOTIONS_VER en
 * el rol customer_b2b de todos los tenants.
 *
 * Contexto: el Portal B2B (repo Portal_MegaDulces / apps/view portal) llama a:
 *   - GET /commercial/warehouses  → resolver el warehouse default del carrito.
 *   - GET /commercial/promotions  → Home/Promos (incluye el banner de promo).
 * Ambos endpoints quedaron con @RequirePermissions tras el security audit.
 * El backfill previo (20260601200000) solo agregó WAREHOUSES_VER y no alcanzó a
 * roles sembrados después; PROMOTIONS_VER nunca estuvo en el rol. Sin esto el
 * portal devuelve 403 a los customer_b2b en catálogo (warehouses) y en promos.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` → solo agrega cuando falta.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const grants = ['COMMERCIAL_WAREHOUSES_VER', 'COMMERCIAL_PROMOTIONS_VER'];
  for (const key of grants) {
    const patch = JSON.stringify({ [key]: true });
    const result = await knex.raw(
      `UPDATE role_permissions
         SET permissions = permissions || :patch::jsonb
       WHERE role_name = 'customer_b2b'
         AND permissions -> :key IS NULL`,
      { patch, key },
    );
    console.log(
      `[add_promotions_and_warehouses_ver_to_customer_b2b] ${key}: ${result.rowCount ?? 0} rol(es) actualizado(s)`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: removerlos rompe el portal B2B.
  console.log(
    '[add_promotions_and_warehouses_ver_to_customer_b2b] down: no-op (revertir rompe portal B2B)',
  );
};
