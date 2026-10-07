/**
 * Backfill: SUPERVISOR_AI_VER + SUPERVISOR_AI_APROBAR (Horus — Supervisor AI de
 * ejecución, Trade) a los roles existentes en entornos ya sembrados. El seed
 * 02_mega_dulces_initial_roles.js ya los incluye (ALL_PERMS + explícito en
 * supervisor/jefe_marketing), pero los role_permissions de prod no se re-siembran solos.
 *
 * _VER  → roles que supervisan ejecución (superadmin, admin, supervisor, jefe_marketing).
 * _APROBAR → solo quienes accionan el co-piloto (superadmin, admin, supervisor).
 *   jefe_marketing observa pero NO aprueba acciones laborales (reasignar/coaching).
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB — knex
 * no lo escapa). Solo agrega donde falta.
 *
 * Recordatorio: el permiso vive en el JWT → los usuarios afectados deben
 * RE-LOGUEARSE para que el item de nav y la ruta queden habilitados.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const roles_ver = ['superadmin', 'admin', 'supervisor', 'jefe_marketing'];
  const patch_ver = JSON.stringify({ SUPERVISOR_AI_VER: true });
  const r1 = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'SUPERVISOR_AI_VER' IS NULL`,
    { patch: patch_ver, roles: roles_ver },
  );

  const roles_aprobar = ['superadmin', 'admin', 'supervisor'];
  const patch_aprobar = JSON.stringify({ SUPERVISOR_AI_APROBAR: true });
  const r2 = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'SUPERVISOR_AI_APROBAR' IS NULL`,
    { patch: patch_aprobar, roles: roles_aprobar },
  );

  console.log(
    `[add_supervisor_ai_to_roles] SUPERVISOR_AI_VER → ${r1.rowCount ?? 0} rol(es), SUPERVISOR_AI_APROBAR → ${r2.rowCount ?? 0} rol(es).`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: quitarlo escondería Horus para supervisores.
  console.log('[add_supervisor_ai_to_roles] down: no-op');
};
