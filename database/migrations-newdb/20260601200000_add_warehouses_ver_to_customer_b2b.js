/**
 * Backfill: agrega COMMERCIAL_WAREHOUSES_VER al rol customer_b2b en todos los tenants.
 *
 * Contexto: el portal B2B (apps/view/src/app/modules/portal/) llama a
 * `GET /commercial/warehouses` para resolver el warehouse default que se usa
 * en el carrito de pedidos. Al cerrar el security audit del módulo se le agregó
 * `@RequirePermissions(COMMERCIAL_WAREHOUSES_VER)` al endpoint. Sin este backfill
 * el portal devolvería 403 a todos los customer_b2b existentes hasta que un
 * admin re-edite el rol manualmente.
 *
 * Idempotente: usa `permissions -> 'KEY' IS NULL` para solo agregar cuando falta.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const patch = JSON.stringify({ COMMERCIAL_WAREHOUSES_VER: true });
  const result = await knex.raw(
    `UPDATE role_permissions
       SET permissions = permissions || :patch::jsonb
     WHERE role_name = 'customer_b2b'
       AND permissions -> 'COMMERCIAL_WAREHOUSES_VER' IS NULL`,
    { patch },
  );
  const updated = result.rowCount ?? 0;
  console.log(
    `[add_warehouses_ver_to_customer_b2b] ${updated} customer_b2b role(s) actualizado(s) (1 por tenant)`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: removerlo rompe el portal B2B.
  console.log(
    '[add_warehouses_ver_to_customer_b2b] down: no-op (revertir rompe portal B2B)',
  );
};
