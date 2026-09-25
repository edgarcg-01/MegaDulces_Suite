/**
 * `[IG.1.4]` Reparte `FINANCE_INCOME_VER` — el permiso de la pantalla de Ingresos contables.
 *
 * ⛔ **Un módulo nuevo no está entregado hasta que su permiso está REPARTIDO en prod, no sólo
 * declarado en el enum.** Es la lección de `[LC.6.2]`: el par `FISCAL_PURCHASE_BOOK_*` nació con su
 * fase, nadie lo repartió, y el módulo estuvo en producción **sin que ningún rol pudiera abrirlo**
 * salvo los `ALL_PERMS`. La pantalla existía y no la veía nadie.
 *
 * ── A QUIÉN, Y POR QUÉ A ÉSOS ────────────────────────────────────────────────────────────
 * Se calca de su hermano `FINANCE_EXPENSES_VER`, **derivado del estado vivo** (medido en prod el
 * 2026-09-25, no copiado de una lista): los 11 roles que hoy pueden ver los egresos contables son
 * exactamente los que tienen sentido para el otro lado del mismo libro —
 *
 *   auditor_externo · auxiliar finanzas · contabilidad · credito_cobranza · direccion · finanzas ·
 *   finanzas_operativo · gerente_compras · marketing · superadmin · tesoreria
 *
 * Es de LECTURA pura (no hay `_GESTIONAR`: la pantalla no escribe nada), así que no hay motivo
 * para recortar respecto del gasto.
 *
 * ⚠️ Se otorga leyendo `FINANCE_EXPENSES_VER = true` en vivo en vez de nombrar los roles a mano: si
 * entre que esto se escribe y se aplica alguien gana o pierde el de egresos, el reparto lo sigue.
 * Una lista de nombres se desactualiza en silencio.
 *
 * ⚠️ NO pisa un `false` explícito: un rol al que alguien le quitó el permiso a propósito desde
 * `/admin/roles` se queda sin él. Sólo se agrega donde la clave no existe todavía.
 *
 * ⚠️ Para preguntar si una clave existe en el JSONB se usa `permissions -> 'KEY' IS NULL`, **NO** el
 * operador `?` de JSONB: knex no lo escapa bien (regla del proyecto).
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
       SET permissions = permissions || '{"FINANCE_INCOME_VER": true}'::jsonb
     WHERE (permissions -> 'FINANCE_EXPENSES_VER')::text = 'true'
       AND permissions -> 'FINANCE_INCOME_VER' IS NULL
    RETURNING role_name`);

  // Deja rastro de a quién le tocó: si mañana alguien pregunta por qué un rol lo tiene, la
  // respuesta está en el log de la migración y no hay que reconstruirla.
  if (rows?.length) {
    // eslint-disable-next-line no-console
    console.log(`  [IG.1.4] FINANCE_INCOME_VER otorgado a ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ')}`);
  }
};

exports.down = async function (knex) {
  const tabla = await knex.raw(`SELECT to_regclass('identity.role_permissions') AS t`);
  if (!tabla.rows[0]?.t) return;
  await knex.raw(`
    UPDATE identity.role_permissions
       SET permissions = permissions - 'FINANCE_INCOME_VER'
     WHERE permissions -> 'FINANCE_INCOME_VER' IS NOT NULL`);
};
