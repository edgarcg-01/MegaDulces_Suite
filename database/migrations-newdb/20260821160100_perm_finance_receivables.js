/**
 * CXC (ADR-048) — Permiso propio de Cartera de clientes / Partidas vivas.
 *
 * FINANCE_RECEIVABLES_VER = consultar el estado de cuenta CxC (cartera + aging +
 * drill por cliente) read-only sobre Kepler. Backfill anclado a FINANCE_BANK_VER
 * (misma área de Finanzas): ningún rol que ya opera Finanzas pierde acceso.
 * Idempotente (`-> 'KEY' IS NULL`). customer_b2b explícito en false. Requiere RE-LOGIN.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const key = 'FINANCE_RECEIVABLES_VER';
  const anchor = 'FINANCE_BANK_VER';
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('${key}',
              CASE WHEN role_name = 'customer_b2b' THEN false
                   ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
      WHERE permissions -> '${key}' IS NULL`,
  );
  console.log(`[perm_finance_receivables] up ${key} ← ${anchor}: filas = ${res.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_RECEIVABLES_VER' WHERE permissions -> 'FINANCE_RECEIVABLES_VER' IS NOT NULL`);
};
