/**
 * CC — Permisos propios del módulo Comprobantes de Cobranza.
 *
 * FINANCE_COLLECTIONS_VER / _GESTIONAR = adjuntar la ficha de depósito + OCR a un
 * cobro de Kepler (UA0501) y validarla. Backfill que ancla a los permisos de Bancos
 * (misma área de Finanzas), para que NINGÚN rol que ya opera Finanzas pierda acceso:
 *   - FINANCE_COLLECTIONS_VER       ← FINANCE_BANK_VER
 *   - FINANCE_COLLECTIONS_GESTIONAR ← FINANCE_BANK_GESTIONAR
 *
 * Idempotente (solo escribe donde la KEY no existe, patrón `-> 'KEY' IS NULL`).
 * customer_b2b explícito en false. Requiere RE-LOGIN (el JWT lleva los permisos).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ANCHOR = {
    FINANCE_COLLECTIONS_VER: 'FINANCE_BANK_VER',
    FINANCE_COLLECTIONS_GESTIONAR: 'FINANCE_BANK_GESTIONAR',
  };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[finance_collections_perms] up ${key} ← ${anchor}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_COLLECTIONS_VER' WHERE permissions -> 'FINANCE_COLLECTIONS_VER' IS NOT NULL`);
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_COLLECTIONS_GESTIONAR' WHERE permissions -> 'FINANCE_COLLECTIONS_GESTIONAR' IS NOT NULL`);
};
