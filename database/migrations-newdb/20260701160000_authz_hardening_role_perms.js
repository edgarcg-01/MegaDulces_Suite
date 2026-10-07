/**
 * Endurecimiento de autorización — alinea los roles vivos con el guard por
 * CLAVE EXACTA (RolesGuard ya no colapsa Permission→subject; ver
 * libs/platform-core/.../guards/roles.guard.ts). Con el chequeo exacto, cada rol
 * necesita literalmente la clave de cada acción que ejecuta.
 *
 * Deltas (idempotentes, merge `||` guardado por containment `@>`):
 *   1. supervisor              +COMMERCIAL_ORDERS_CREAR
 *        (override gerencial: toma pedidos en la app de vendedor vía
 *         VENDOR_APP_ACCESS → POST /commercial/orders exige CREAR)
 *   2. tele_operator           +COMMERCIAL_TELEVENTA_VER
 *        (el controller de televenta ahora exige VER en sus rutas de lectura;
 *         el operador ya tenía OPERATE, le faltaba VER)
 *   3. colaborador/ejecutivo/vendedor  -COMMERCIAL_INVENTORY_VER
 *        (desacople cross-módulo: el stock para vender llega por el catálogo
 *         /commercial/catalog/products bajo ORDERS_VER — el vendedor NO necesita
 *         el módulo de inventario para "ver almacén". Conservan INVENTORY_CONTAR
 *         quien lo tenga, para el conteo físico ciego.)
 *
 * El ciclo de pedido de campo (CONFIRMAR/FULFILL/CANCELAR) ya fue otorgado por
 * 20260610110000 — no se repite acá.
 *
 * NOTA: los permisos viajan en el JWT para el gating de UI → los usuarios
 * afectados deben re-loguear. La autorización backend es fresca (cache 30s), no
 * requiere re-login.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1. supervisor +ORDERS_CREAR
  const supPatch = JSON.stringify({ COMMERCIAL_ORDERS_CREAR: true });
  const r1 = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = 'supervisor'
        AND NOT (permissions @> :patch::jsonb)`,
    { patch: supPatch },
  );

  // 2. tele_operator +TELEVENTA_VER
  const telePatch = JSON.stringify({ COMMERCIAL_TELEVENTA_VER: true });
  const r2 = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = 'tele_operator'
        AND NOT (permissions @> :patch::jsonb)`,
    { patch: telePatch },
  );

  // 3. roles de campo -INVENTORY_VER (desacople). Merge a false; guardado por
  //    "solo si actualmente está en true".
  const invOff = JSON.stringify({ COMMERCIAL_INVENTORY_VER: false });
  const invOn = JSON.stringify({ COMMERCIAL_INVENTORY_VER: true });
  const r3 = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :off::jsonb
      WHERE role_name = ANY(:roles)
        AND (permissions @> :on::jsonb)`,
    { off: invOff, on: invOn, roles: ['colaborador', 'ejecutivo', 'vendedor'] },
  );

  console.log(
    `[authz_hardening_role_perms] supervisor+CREAR=${r1.rowCount ?? 0}, tele_operator+TELEVENTA_VER=${r2.rowCount ?? 0}, field-INVENTORY_VER=${r3.rowCount ?? 0}`,
  );
};

/**
 * Revierte los deltas: restaura INVENTORY_VER de campo y quita las claves
 * agregadas. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_INVENTORY_VER": true}'::jsonb
      WHERE role_name = ANY(:roles)`,
    { roles: ['colaborador', 'ejecutivo', 'vendedor'] },
  );
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_ORDERS_CREAR": false}'::jsonb
      WHERE role_name = 'supervisor'`,
  );
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_TELEVENTA_VER": false}'::jsonb
      WHERE role_name = 'tele_operator'`,
  );
  console.log('[authz_hardening_role_perms] down: deltas revertidos');
};
