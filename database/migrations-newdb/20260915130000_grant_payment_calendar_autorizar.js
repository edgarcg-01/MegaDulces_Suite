'use strict';
/**
 * Fase TP.6 (ADR-064) — Otorga `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` a los roles de
 * GERENCIA/DIRECCIÓN, deliberadamente DISTINTOS de `tesoreria`/`finanzas`/`auxiliar_finanzas`
 * (que preparan el lote con `FINANCE_PAYMENTS_GESTIONAR`). Es la separación de funciones que
 * pidió el usuario: quien prepara no es quien autoriza.
 *
 * ── Idempotente por `IS NULL`, no por `COALESCE(...) IS NOT TRUE` ────────────────────
 * Mismo fix que `20260914150000_grant_presupuestos_to_roles.js` (revisión PR #100, Edgar):
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó" — un `false` explícito (decisión manual desde
 * `/admin/roles`) NO se pisa. Se apunta por `id` de fila, no por `role_name` (la tabla es por
 * tenant y un mismo rol puede tener varias filas).
 *
 * Tolerante a roles que no existan en un tenant dado. Requiere RE-LOGIN (los permisos viajan en
 * el JWT).
 *
 * @param { import("knex").Knex } knex
 */
const PERM = 'FINANCE_PAYMENT_CALENDAR_AUTORIZAR';
const ROLES = ['gerente_finanzas', 'direccion', 'superadmin'];

exports.up = async function up(knex) {
  const { rows: destino } = await knex.raw(
    `SELECT id, role_name, permissions -> ?::text AS ya
       FROM identity.role_permissions
      WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL`,
    [PERM, ROLES],
  );
  const nuevos = destino.filter((r) => r.ya === null);
  const enFalse = destino.filter((r) => r.ya === false).map((r) => r.role_name);

  if (nuevos.length) {
    const patch = JSON.stringify({ [PERM]: true });
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE id = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
      [patch, nuevos.map((r) => r.id), PERM],
    );
    console.log(`[grant_payment_calendar_autorizar] ${PERM} otorgado en ${res.rowCount ?? 0} fila(s): ${nuevos.map((r) => r.role_name).join(', ')}`);
  } else {
    console.log(`[grant_payment_calendar_autorizar] ${PERM}: ningún rol nuevo por tocar.`);
  }
  if (enFalse.length) {
    console.log(`[grant_payment_calendar_autorizar] ${PERM} en false (decisión manual, NO se pisa): ${enFalse.join(', ')}`);
  }

  const cobertura = await knex.raw(
    `SELECT rp.role_name,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id
                AND lower(u.role_name) = lower(rp.role_name)
                AND u.deleted_at IS NULL) AS usuarios
       FROM identity.role_permissions rp
      WHERE lower(rp.role_name) = ANY(?::text[])
        AND rp.deleted_at IS NULL
        AND (rp.permissions->>?::text)::boolean IS TRUE
      ORDER BY 2 DESC, 1`,
    [ROLES, PERM],
  );
  let total = 0;
  for (const r of cobertura.rows) {
    total += Number(r.usuarios);
    if (Number(r.usuarios) > 0) console.log(`  ${r.role_name}: ${r.usuarios} usuario(s) con ${PERM}`);
  }
  console.log(`[grant_payment_calendar_autorizar] usuarios que pueden AUTORIZAR: ${total} — deben RE-LOGUEAR`);

  // Control: que tesoreria/finanzas/auxiliar_finanzas (quienes PREPARAN) NO lo tengan de paquete.
  const leak = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE lower(role_name) = ANY(ARRAY['tesoreria','finanzas','auxiliar_finanzas']) AND deleted_at IS NULL
        AND (permissions->>?::text)::boolean IS TRUE`,
    [PERM],
  );
  if (leak.rows.length) console.warn(`[grant_payment_calendar_autorizar] ⚠️ roles preparadores con AUTORIZAR (revisar separación de funciones): ${leak.rows.map((r) => r.role_name).join(', ')}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  const off = JSON.stringify({ [PERM]: false });
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || ?::jsonb, updated_at = now()
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [off, PERM],
  );
};
