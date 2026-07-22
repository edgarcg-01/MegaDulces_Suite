/**
 * CB — Permisos propios del módulo Bancos (ADR-033).
 *
 * Bancos deja de reusar FINANCE_EXPENSES_VER / FINANCE_FINDINGS_GESTIONAR y pasa a
 * tener permisos dedicados (independencia de permisos por módulo). Este backfill
 * ancla los nuevos a los que Bancos usaba, para que NINGÚN rol pierda acceso:
 *   - FINANCE_BANK_VER       ← FINANCE_EXPENSES_VER (quien veía Finanzas ve Bancos)
 *   - FINANCE_BANK_GESTIONAR ← FINANCE_FINDINGS_GESTIONAR (quien gestionaba, gestiona)
 *
 * Idempotente (solo escribe donde la KEY no existe, patrón `-> 'KEY' IS NULL`).
 * customer_b2b explícito en false. Requiere RE-LOGIN (el JWT lleva los permisos).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ANCHOR = {
    FINANCE_BANK_VER: 'FINANCE_EXPENSES_VER',
    FINANCE_BANK_GESTIONAR: 'FINANCE_FINDINGS_GESTIONAR',
  };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[finance_bank_perms] up ${key} ← ${anchor}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_BANK_VER' WHERE permissions -> 'FINANCE_BANK_VER' IS NOT NULL`);
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_BANK_GESTIONAR' WHERE permissions -> 'FINANCE_BANK_GESTIONAR' IS NOT NULL`);
};
