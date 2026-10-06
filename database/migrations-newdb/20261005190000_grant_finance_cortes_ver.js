/**
 * `[CSU.1]` Reparte `FINANCE_CORTES_VER` — el permiso de la pantalla Cortes/Sucursales.
 *
 * ⛔ Un módulo nuevo no está entregado hasta que su permiso está REPARTIDO en prod, no sólo
 * declarado en el enum (lección `[LC.6.2]`).
 *
 * ── A QUIÉN, Y POR QUÉ A ÉSOS ────────────────────────────────────────────────────────────
 * Se calca de `FINANCE_INCOME_VER` (Ingresos contables), **derivado del estado vivo**: es la misma
 * gente que mira el lado ingreso del libro, y Cortes/Sucursales es ese ingreso visto por turno de
 * caja. Medido en prod el 2026-10-05: 11 roles —
 *
 *   auditor_externo · auxiliar finanzas · contabilidad · credito_cobranza · direccion · finanzas ·
 *   finanzas_operativo · gerente_compras · marketing · superadmin · tesoreria
 *
 * Es de LECTURA pura (no hay `_GESTIONAR`: el cobro se captura en Kepler).
 *
 * ⚠️ NO pisa un `false` explícito. Para preguntar si la clave existe se usa
 * `permissions -> 'KEY' IS NULL`, NO el operador `?` de JSONB (knex no lo escapa bien).
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const tabla = await knex.raw(`SELECT to_regclass('identity.role_permissions') AS t`);
  if (!tabla.rows[0]?.t) return; // entorno sin el módulo de identidad

  const { rows } = await knex.raw(`
    UPDATE identity.role_permissions
       SET permissions = permissions || '{"FINANCE_CORTES_VER": true}'::jsonb
     WHERE (permissions -> 'FINANCE_INCOME_VER')::text = 'true'
       AND permissions -> 'FINANCE_CORTES_VER' IS NULL
    RETURNING role_name`);

  if (rows?.length) {
    // eslint-disable-next-line no-console
    console.log(`  [CSU.1] FINANCE_CORTES_VER otorgado a ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ')}`);
  }
};

exports.down = async function (knex) {
  const tabla = await knex.raw(`SELECT to_regclass('identity.role_permissions') AS t`);
  if (!tabla.rows[0]?.t) return;
  await knex.raw(`
    UPDATE identity.role_permissions
       SET permissions = permissions - 'FINANCE_CORTES_VER'
     WHERE permissions -> 'FINANCE_CORTES_VER' IS NOT NULL`);
};
