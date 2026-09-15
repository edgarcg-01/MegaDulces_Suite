'use strict';
/**
 * Fase TP.2 — Otorga PRESUPUESTOS_VER/GESTIONAR al rol legado `coordinador_presupuestos`
 * (existe en el padrón — `LEGACY_ROLE_AREA` en role-presets.ts ya lo mapea al área 'finanzas' —
 * pero hoy no tiene NINGÚN permiso del dominio de Presupuestos, porque el dominio no existía).
 *
 * También a `superadmin` (acceso total ya existente por otras vías, pero se declara explícito
 * para que `/admin/roles` lo muestre) y a `gerente_finanzas`/`finanzas` como VER (oversight, sin
 * gestionar — el dueño de Presupuestos es `coordinador_presupuestos`).
 *
 * Mismo patrón que `20260821120000_grant_expenses_capturar_to_roles.js`: UPDATE directo sobre
 * `identity.role_permissions`, tolerante a roles que no existan en un tenant dado. Requiere
 * RE-LOGIN (los permisos viajan en el JWT).
 *
 * @param { import("knex").Knex } knex
 */

const GESTIONAR_ROLES = ['coordinador_presupuestos', 'superadmin'];
const VER_ROLES = ['coordinador_presupuestos', 'superadmin', 'gerente_finanzas', 'finanzas'];

async function grant(knex, perm, roles) {
  if (!roles.length) return;
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true),
            updated_at = now()
      WHERE lower(role_name) = ANY(?::text[])
        AND deleted_at IS NULL
        AND COALESCE((permissions->>?::text)::boolean, false) IS NOT TRUE`,
    [perm, roles, perm],
  );
  console.log(`[grant_presupuestos] ${perm} otorgado en ${res.rowCount ?? 0} fila(s) de rol`);
}

exports.up = async function up(knex) {
  await grant(knex, 'PRESUPUESTOS_VER', VER_ROLES);
  await grant(knex, 'PRESUPUESTOS_GESTIONAR', GESTIONAR_ROLES);

  const cobertura = await knex.raw(
    `SELECT rp.role_name,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id
                AND lower(u.role_name) = lower(rp.role_name)
                AND u.deleted_at IS NULL) AS usuarios
       FROM identity.role_permissions rp
      WHERE lower(rp.role_name) = ANY(?::text[])
        AND rp.deleted_at IS NULL
        AND (rp.permissions->>'PRESUPUESTOS_VER')::boolean IS TRUE
      ORDER BY 2 DESC, 1`,
    [VER_ROLES],
  );
  let total = 0;
  for (const r of cobertura.rows) {
    total += Number(r.usuarios);
    if (Number(r.usuarios) > 0) console.log(`  ${r.role_name}: ${r.usuarios} usuario(s) con PRESUPUESTOS_VER`);
  }
  console.log(`[grant_presupuestos] usuarios con acceso a /finanzas/presupuesto: ${total} — deben RE-LOGUEAR`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object('PRESUPUESTOS_VER', false, 'PRESUPUESTOS_GESTIONAR', false)
      WHERE lower(role_name) = ANY(?::text[])`,
    [VER_ROLES],
  );
};
