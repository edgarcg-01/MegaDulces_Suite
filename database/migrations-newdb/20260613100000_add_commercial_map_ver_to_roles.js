/**
 * Backfill: otorga COMMERCIAL_MAP_VER (módulo "Mapa Comercial": exhibidores
 * Mega Dulces vs competencia + historial por tienda) a los roles supervisorios
 * en entornos ya sembrados. El seed 02_mega_dulces_initial_roles.js ya lo
 * incluye (ALL_PERMS → superadmin/admin; explícito en supervisor/jefe_marketing),
 * pero los role_permissions de prod no se re-siembran solos.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO usar el operador `?` de JSONB —
 * knex no lo escapa). Solo agrega donde falta. Mismo conjunto de roles que el
 * apartado análogo Rutas (20260608100000): roles de campo/externos
 * (colaborador, vendedor, tele_operator, customer_b2b) NO lo reciben — la vista
 * es supervisoria y su nav vive en la rama fullDashboard.
 *
 * Recordatorio: el permiso vive en el JWT → los usuarios afectados deben
 * RE-LOGUEARSE para que el item de nav y la ruta queden habilitados.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const roles = ['superadmin', 'admin', 'supervisor', 'jefe_marketing'];
  const patch = JSON.stringify({ COMMERCIAL_MAP_VER: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'COMMERCIAL_MAP_VER' IS NULL`,
    { patch, roles },
  );
  console.log(
    `[add_commercial_map_ver_to_roles] COMMERCIAL_MAP_VER otorgado a ${result.rowCount ?? 0} rol(es).`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: quitarlo rompería el Mapa Comercial para supervisores.
  console.log('[add_commercial_map_ver_to_roles] down: no-op');
};
