/**
 * RESCATE: restaura los permisos canónicos del rol `superadmin` (y `admin` si
 * existe) cuando la fila se corrompió.
 *
 * Causa del incidente: el endpoint `PUT /api/catalogs/role-permissions/:role`
 * reemplaza por completo el JSONB de permisos con lo que llegue del body. Si
 * el frontend (o alguien con permisos) posteó un set parcial o equivocado al
 * rol `superadmin`, quedó con permisos de un rol menor.
 *
 * Esta migración hace UPSERT (vía UPDATE WHERE role_name) del set completo de
 * permisos del enum `Permission` en `true` para los roles privilegiados. NO
 * toca otros roles: si alguien personalizó "supervisor" o "colaborador" no se
 * pierde el ajuste.
 *
 * Es idempotente: si ya están todos en true, el UPDATE no produce diff.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */

// Mirror del enum Permission de apps/api/src/shared/constants/permissions.ts.
// Mantener sincronizado si se agregan permisos nuevos al enum.
const ALL_PERMISSIONS = {
  USUARIOS_VER: true,
  USUARIOS_GESTIONAR: true,
  USUARIOS_PASSWORDS: true,
  USUARIOS_ASIGNAR_RUTA: true,
  REPORTES_VER_PROPIO: true,
  REPORTES_VER_EQUIPO: true,
  REPORTES_VER_GLOBAL: true,
  REPORTES_EXPORTAR: true,
  REPORTES_GESTIONAR: true,
  VISITAS_REGISTRAR: true,
  VISITAS_VER: true,
  VISITAS_AUDITAR: true,
  CATALOGO_GESTIONAR: true,
  PLANOGRAMAS_GESTIONAR: true,
  TIENDAS_VER: true,
  TIENDAS_CREAR: true,
  ROLES_CONFIGURAR: true,
  SCORING_CONFIG_VER: true,
  SCORING_CONFIG_GESTIONAR: true,
  VER_SEGUIMIENTO: true,
};

// Roles que SIEMPRE deben tener acceso total. Si en la DB hay variantes con
// distinto casing (p.ej. "SuperAdmin"), las matcheamos case-insensitive.
const PRIVILEGED_ROLE_NAMES = ['superadmin', 'admin'];

exports.up = async function (knex) {
  const allRows = await knex('role_permissions').select('role_name');
  const targets = allRows
    .map((r) => r.role_name)
    .filter((name) =>
      PRIVILEGED_ROLE_NAMES.includes(String(name).toLowerCase()),
    );

  if (targets.length === 0) {
    console.log(
      '[restore_superadmin_permissions] No se encontraron roles privilegiados — nada que restaurar.',
    );
    return;
  }

  for (const roleName of targets) {
    await knex('role_permissions')
      .where({ role_name: roleName })
      .update({
        permissions: ALL_PERMISSIONS,
        updated_at: knex.fn.now(),
      });
    console.log(
      `[restore_superadmin_permissions] Restaurado: ${roleName} (todos los permisos en true).`,
    );
  }
};

/**
 * No-op down: revertir esto podría dejar al superadmin sin acceso al panel
 * de roles y bloquear cualquier corrección posterior.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function () {
  console.log(
    '[restore_superadmin_permissions] down: no-op (revertir bloquearía el panel admin).',
  );
};
