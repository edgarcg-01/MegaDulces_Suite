/**
 * Backfill (DB legacy): otorga VENDOR_APP_ACCESS a los roles que deben entrar a
 * la app de vendedor standalone (apps/vendor). Espejo de la migración
 * equivalente en migrations-newdb/ y de los seeds 00_roles.js / 02_mega_...
 *
 * Roles otorgados (canónicos del seed legacy):
 *   superadmin, admin            → acceso total / soporte
 *   supervisor, supervisor_ventas → override gerencial
 *   colaborador, ejecutivo       → vendedores de campo (FIELD_PERMS)
 *
 * jefe_marketing NO lo recibe (rol de análisis, comercial solo lectura).
 *
 * IDEMPOTENTE: `permissions -> 'KEY' IS NULL` (NO el operador `?` — knex no lo
 * escapa). Nunca pisa un valor puesto manualmente vía /admin/roles. Requiere
 * RE-LOGIN para que el permiso entre al JWT.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const key = 'VENDOR_APP_ACCESS';
  const roles = [
    'superadmin',
    'admin',
    'supervisor',
    'supervisor_ventas',
    'colaborador',
    'ejecutivo',
  ];
  const patch = JSON.stringify({ [key]: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> :key IS NULL`,
    { patch, roles, key },
  );
  console.log(
    `[backfill_vendor_app_access] ${key} otorgado a ${result.rowCount ?? 0} rol(es).`,
  );
};

exports.down = async function () {
  console.log('[backfill_vendor_app_access] down: no-op.');
};
