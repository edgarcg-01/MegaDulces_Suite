'use strict';
/**
 * Completa `[UN.10]`: dos personas del listado de gastos SÍ existían, pero bajo
 * un nombre distinto al del Excel, así que su rol no entró en la migración
 * `20260821120000`.
 *
 *   FERNANDA PATLAN   -> `fer_zambrano`   "FERNANDA ZAMBRANO"  (coordinadora_marketing)
 *       En los datos de POS figura como "Fernanda Guadalupe PATLÁN ZAMBRANO":
 *       el sistema guardó solo el segundo apellido.
 *   MARIPAZ GUTIERREZ -> `maria_gutierrez` "María de la Paz Gutiérrez Guzmán" (gestor_tesoreria)
 *       MariPaz = María de la Paz.
 *
 * Va en migración aparte y no editando `20260821120000` porque esa ya corrió en
 * local: modificar una migración aplicada es justo lo que rompe el chequeo de
 * knex_migrations contra el filesystem.
 *
 * Mismo criterio que la anterior: SOLO `FINANCE_EXPENSES_CAPTURAR`, nunca
 * `FINANCE_EXPENSES_VER` (el permiso ancho del módulo de gastos).
 *
 * Requiere RE-LOGIN.
 *
 * @param { import("knex").Knex } knex
 */

const PERM = 'FINANCE_EXPENSES_CAPTURAR';
const ROLES = ['coordinadora_marketing', 'gestor_tesoreria'];

exports.up = async function up(knex) {
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true),
            updated_at = now()
      WHERE lower(role_name) = ANY(?::text[])
        AND deleted_at IS NULL
        AND COALESCE((permissions->>?::text)::boolean, false) IS NOT TRUE`,
    [PERM, ROLES, PERM],
  );
  console.log(`[grant_expenses_capturar_extra] ${PERM} otorgado en ${res.rowCount ?? 0} filas de rol`);

  const det = await knex.raw(
    `SELECT rp.role_name,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id
                AND lower(u.role_name) = lower(rp.role_name)
                AND u.deleted_at IS NULL) AS usuarios
       FROM identity.role_permissions rp
      WHERE lower(rp.role_name) = ANY(?::text[]) AND rp.deleted_at IS NULL
      ORDER BY 1`,
    [ROLES],
  );
  for (const r of det.rows) console.log(`  ${r.role_name}: ${r.usuarios} usuario(s)`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, false)
      WHERE lower(role_name) = ANY(?::text[])`,
    [PERM, ROLES],
  );
};
