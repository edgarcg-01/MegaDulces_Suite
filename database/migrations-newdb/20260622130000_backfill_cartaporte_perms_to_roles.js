/**
 * J12.0 — Backfill: otorga LOGISTICS_CARTAPORTE_VER / _GESTIONAR a los roles que
 * deben timbrar Carta Porte. Sin esto, la key queda AUSENTE del JSONB en roles
 * sembrados antes de este permiso (el seed no se vuelve a correr en prod).
 *
 * Roles: superadmin, admin (Carta Porte = fiscal → autoridad administrativa).
 * supervisor NO la recibe (no maneja logística en el seed).
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?`). Requiere
 * RE-LOGIN para que el permiso entre al JWT.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const keys = ['LOGISTICS_CARTAPORTE_VER', 'LOGISTICS_CARTAPORTE_GESTIONAR'];
  const roles = ['superadmin', 'admin'];
  for (const key of keys) {
    const patch = JSON.stringify({ [key]: true });
    const result = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || :patch::jsonb
        WHERE role_name = ANY(:roles)
          AND permissions -> :key IS NULL`,
      { patch, roles, key },
    );
    console.log(`[backfill_cartaporte] ${key} otorgado a ${result.rowCount ?? 0} rol(es).`);
  }
};

exports.down = async function () {
  console.log('[backfill_cartaporte] down: no-op');
};
