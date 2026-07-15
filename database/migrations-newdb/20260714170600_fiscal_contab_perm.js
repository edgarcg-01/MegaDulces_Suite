/**
 * FISCAL.9 — Permiso de contabilidad electrónica (XMLs SAT: catálogo + balanza).
 *
 * No crea tablas: los XML se generan on-the-fly desde analytics.ledger_monthly.
 * Solo backfilea el permiso FISCAL_CONTAB_VER (anclado al de gastos existente).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ANCHOR = { FISCAL_CONTAB_VER: 'FINANCE_EXPENSES_VER' };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_contab_perm] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_CONTAB_VER' WHERE permissions -> 'FISCAL_CONTAB_VER' IS NOT NULL`);
};
