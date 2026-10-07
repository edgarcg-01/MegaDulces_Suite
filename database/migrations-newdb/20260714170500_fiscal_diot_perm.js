/**
 * FISCAL.8 — Permiso de lectura DIOT + conciliación de IVA.
 *
 * No crea tablas: la DIOT y el resumen de IVA se calculan on-the-fly desde
 * fiscal.cfdis + fiscal.cfdi_payment_links (IVA efectivamente pagado). Solo
 * backfilea el permiso FISCAL_DIOT_VER (anclado al de gastos existente).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ANCHOR = { FISCAL_DIOT_VER: 'FINANCE_EXPENSES_VER' };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_diot_perm] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_DIOT_VER' WHERE permissions -> 'FISCAL_DIOT_VER' IS NOT NULL`);
};
