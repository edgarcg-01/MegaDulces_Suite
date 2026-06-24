/**
 * Fase DENUE — Backfill: otorga COMMERCIAL_MAP_PROSPECTS_VER / _GESTIONAR a los
 * roles que ya ven el mapa comercial. Sin esto la key queda AUSENTE del JSONB en
 * roles sembrados antes de este permiso (el seed no se vuelve a correr en prod).
 *
 * Roles: superadmin, admin (gestión completa). supervisor recibe solo VER.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?`). Requiere
 * RE-LOGIN para que el permiso entre al JWT.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const grants = [
    { key: 'COMMERCIAL_MAP_PROSPECTS_VER', roles: ['superadmin', 'admin', 'supervisor'] },
    { key: 'COMMERCIAL_MAP_PROSPECTS_GESTIONAR', roles: ['superadmin', 'admin'] },
  ];
  for (const { key, roles } of grants) {
    const patch = JSON.stringify({ [key]: true });
    const result = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || :patch::jsonb
        WHERE role_name = ANY(:roles)
          AND permissions -> :key IS NULL`,
      { patch, roles, key },
    );
    console.log(`[backfill_prospects] ${key} otorgado a ${result.rowCount ?? 0} rol(es).`);
  }
};

exports.down = async function () {
  console.log('[backfill_prospects] down: no-op');
};
