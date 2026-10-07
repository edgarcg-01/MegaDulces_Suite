/**
 * Backfill: otorga RUTAS_VER (apartado de análisis de rutas) a los roles que lo
 * usan en entornos ya sembrados. El seed 02_mega_dulces_initial_roles.js ya lo
 * incluye (ALL_PERMS → superadmin/admin; explícito en supervisor/jefe_marketing),
 * pero los role_permissions de prod no se re-siembran solos.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO usar el operador `?` de JSONB —
 * knex no lo escapa). Solo agrega donde falta. Roles de campo/externos
 * (colaborador, vendedor, tele_operator, customer_b2b) NO lo reciben: el apartado
 * es supervisorio y su nav está en la rama fullDashboard.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const roles = ['superadmin', 'admin', 'supervisor', 'jefe_marketing'];
  const patch = JSON.stringify({ RUTAS_VER: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'RUTAS_VER' IS NULL`,
    { patch, roles },
  );
  console.log(`[add_rutas_ver_to_roles] RUTAS_VER otorgado a ${result.rowCount ?? 0} rol(es).`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: quitarlo rompería el apartado Rutas para supervisores.
  console.log('[add_rutas_ver_to_roles] down: no-op');
};
