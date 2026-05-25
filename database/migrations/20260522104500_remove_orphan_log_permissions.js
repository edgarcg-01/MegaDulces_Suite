/**
 * Remueve 18 permisos huérfanos LOG_* del JSONB de role_permissions.
 *
 * Estas claves quedaron de un módulo de logística (embarques, guías,
 * liquidaciones, unidades, colaboradores, reportes_log) que aparentemente
 * fue removido o nunca cableado. No están referenciadas en ningún archivo
 * de `apps/` (ni @RequirePermissions en backend, ni permissionGuard en
 * frontend), pero el seed `00_roles.js` las sigue insertando, ensuciando
 * el panel /roles con filas sin metadata.
 *
 * Idempotente: el operador `jsonb - text[]` no falla si las claves no
 * existen, simplemente las omite.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const ORPHAN_KEYS = [
  'LOG_CATALOGOS_VER',
  'LOG_CATALOGOS_GESTIONAR',
  'LOG_COLABORADORES_VER',
  'LOG_COLABORADORES_GESTIONAR',
  'LOG_EMBARQUES_VER',
  'LOG_EMBARQUES_CREAR',
  'LOG_EMBARQUES_EDITAR',
  'LOG_EMBARQUES_ELIMINAR',
  'LOG_GUIAS_VER',
  'LOG_GUIAS_CREAR',
  'LOG_GUIAS_EDITAR',
  'LOG_GUIAS_ELIMINAR',
  'LOG_LIQUIDACIONES_VER',
  'LOG_LIQUIDACIONES_GESTIONAR',
  'LOG_REPORTES_VER',
  'LOG_REPORTES_EXPORTAR',
  'LOG_UNIDADES_VER',
  'LOG_UNIDADES_GESTIONAR',
];

exports.up = async function (knex) {
  const result = await knex.raw(
    `UPDATE role_permissions SET permissions = permissions - ?::text[]`,
    [ORPHAN_KEYS],
  );
  const updated = result.rowCount ?? 0;
  console.log(
    `[remove_orphan_log_permissions] ${updated} role(s) limpiados de claves LOG_*`,
  );
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  // No-op: no tiene sentido volver a meter claves que no se usan.
  console.log(
    '[remove_orphan_log_permissions] down: no-op (las claves LOG_* no se usan en código)',
  );
};
