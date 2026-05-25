/**
 * Backfill de permisos faltantes en role_permissions.permissions (JSONB).
 *
 * El enum Permission del backend/frontend tiene 4 claves que históricamente
 * no se seedearon en role_permissions:
 *   - TIENDAS_VER
 *   - TIENDAS_CREAR
 *   - REPORTES_GESTIONAR
 *   - VER_SEGUIMIENTO
 *
 * Sin ellas, todo endpoint protegido con @RequirePermissions(Permission.X) para
 * esas claves devuelve 403 a cualquier rol que no tenga el bypass manage:all
 * (por REPORTES_VER_GLOBAL). El bug reportado: capturistas no pueden crear
 * tiendas durante una visita.
 *
 * Esta migración es IDEMPOTENTE: solo agrega cada clave a los roles donde
 * todavía no existe. No sobreescribe valores manuales puestos vía /roles.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const missingPerms = [
    'TIENDAS_VER',
    'TIENDAS_CREAR',
    'REPORTES_GESTIONAR',
    'VER_SEGUIMIENTO',
  ];

  for (const key of missingPerms) {
    const patch = JSON.stringify({ [key]: true });
    const result = await knex.raw(
      `UPDATE role_permissions
         SET permissions = permissions || ?::jsonb
       WHERE NOT (permissions ? ?)`,
      [patch, key],
    );
    const updated = result.rowCount ?? 0;
    console.log(
      `[backfill_missing_role_permissions] ${key}: ${updated} role(s) actualizados`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  // No-op: removerlos rompería la autorización de quien ya los esté usando.
  // Si fuera estrictamente necesario revertir, se haría manualmente con:
  //   UPDATE role_permissions SET permissions = permissions - 'TIENDAS_CREAR' ...
  console.log(
    '[backfill_missing_role_permissions] down: no-op (revertir rompería autorización en runtime)',
  );
};
