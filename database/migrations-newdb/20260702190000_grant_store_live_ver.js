/**
 * Proyecto Tienda (TDA) — otorga STORE_LIVE_VER a los roles de gerencia/supervisión
 * para que vean el proyecto "Tienda" (monitor de tickets en vivo).
 *
 * admin/superadmin ya acceden vía manage:all; se agregan explícitos igual (inocuo,
 * hace que el card aparezca por el chequeo de permiso del frontend). supervisor lo
 * necesita explícito.
 *
 * Idempotente (merge `||` guardado por containment `@>`). Los permisos viajan en el
 * JWT → los usuarios afectados deben RE-LOGUEAR para ver el card/nav.
 *
 * @param { import("knex").Knex } knex
 */
const ROLES = ['superadmin', 'admin', 'supervisor', 'supervisor_ventas', 'encargado_sucursal', 'jefe_marketing'];

exports.up = async function (knex) {
  const patch = JSON.stringify({ STORE_LIVE_VER: true });
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND NOT (permissions @> :patch::jsonb)`,
    { patch, roles: ROLES },
  );
};

exports.down = async function (knex) {
  const off = JSON.stringify({ STORE_LIVE_VER: false });
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :off::jsonb
      WHERE role_name = ANY(:roles)`,
    { off, roles: ROLES },
  );
};
