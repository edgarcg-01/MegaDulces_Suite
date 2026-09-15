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
 * ── Idempotente por `IS NULL`, no por `COALESCE(...) IS NOT TRUE` ────────────────────
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó". Un `false` explícito (decisión manual desde
 * `/admin/roles`) NO se pisa — mismo patrón que `20260914120000_grant_almacen_bi_perm.js`. La
 * versión anterior de este archivo usaba `COALESCE(...) IS NOT TRUE`, que trata "nunca se tocó"
 * y "false explícito" igual: en el primer `apply` no hay diferencia (nada es `false` todavía),
 * pero un re-apply contra una DB donde alguien ya puso `false` a mano habría pisado esa decisión.
 * Corregido en revisión de PR #100 (Edgar).
 *
 * Se apunta por `id` de fila (no por `role_name`): la tabla es por tenant y un mismo rol puede
 * tener varias filas — filtrar por nombre tocaría también la fila de otro tenant.
 *
 * Los permisos viajan en el JWT → los usuarios afectados deben RE-LOGUEAR.
 *
 * @param { import("knex").Knex } knex
 */

const GESTIONAR_ROLES = ['coordinador_presupuestos', 'superadmin'];
const VER_ROLES = ['coordinador_presupuestos', 'superadmin', 'gerente_finanzas', 'finanzas'];

async function grant(knex, perm, roles) {
  if (!roles.length) return;
  const { rows: destino } = await knex.raw(
    `SELECT id, role_name, permissions -> ?::text AS ya
       FROM identity.role_permissions
      WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL`,
    [perm, roles],
  );
  const nuevos = destino.filter((r) => r.ya === null);
  const enFalse = destino.filter((r) => r.ya === false).map((r) => r.role_name);
  if (nuevos.length) {
    const patch = JSON.stringify({ [perm]: true });
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE id = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
      [patch, nuevos.map((r) => r.id), perm],
    );
    console.log(`[grant_presupuestos] ${perm} otorgado en ${res.rowCount ?? 0} fila(s): ${nuevos.map((r) => r.role_name).join(', ')}`);
  } else {
    console.log(`[grant_presupuestos] ${perm}: ningún rol nuevo por tocar.`);
  }
  if (enFalse.length) {
    console.log(`[grant_presupuestos] ${perm} en false (decisión manual, NO se pisa): ${enFalse.join(', ')}`);
  }
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
  // Se apaga la clave (false explícito, no se borra) en los roles que la tienen en true.
  for (const perm of ['PRESUPUESTOS_VER', 'PRESUPUESTOS_GESTIONAR']) {
    const off = JSON.stringify({ [perm]: false });
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
      [off, perm],
    );
  }
};
