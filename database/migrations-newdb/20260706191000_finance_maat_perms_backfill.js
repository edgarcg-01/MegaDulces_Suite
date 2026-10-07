/**
 * MAAT.0 — permisos FINANCE_AI_CHAT + FINANCE_FINDINGS_GESTIONAR + backfill.
 *
 * Gates de la AI de Finanzas (ADR-028): el chat "Pregúntale a Maat" y la
 * gestión de hallazgos/conocimiento. Todo rol que hoy tiene
 * FINANCE_EXPENSES_VER hereda ambos con el mismo valor (mismo criterio que
 * la migración 20260706170000). `customer_b2b` (externo) queda fuera.
 *
 * Idempotente: escribe cada clave sólo si no existe (`-> 'KEY' IS NULL`, NO
 * el operador `?` que knex no escapa). Frontend gatea por JWT → re-login.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  for (const key of ['FINANCE_AI_CHAT', 'FINANCE_FINDINGS_GESTIONAR']) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'FINANCE_EXPENSES_VER')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[finance_maat_perms_backfill] up ${key}: filas actualizadas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  for (const key of ['FINANCE_AI_CHAT', 'FINANCE_FINDINGS_GESTIONAR']) {
    await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions - '${key}'
        WHERE permissions -> '${key}' IS NOT NULL`,
    );
  }
  console.log('[finance_maat_perms_backfill] down: claves removidas');
};
