/**
 * Hotfix — `thot_chat_log.feedback` / `.promoted` faltantes.
 *
 * La migración 20260701130000 usó `alterTable(tbl, async (t) => { await hasColumn... })`
 * — el builder de knex es SÍNCRONO, así que el callback async NO agregó las columnas
 * (quedó marcada como aplicada pero sin efecto). Resultado: `candidates()` y el
 * feedback 👍/👎 truenan (columna inexistente). Esta migración las agrega con el
 * patrón correcto: `await hasColumn` ANTES, luego `alterTable` con callback SÍNCRONO.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_log'))) return;
  if (!(await knex.schema.withSchema('commercial').hasColumn('thot_chat_log', 'feedback'))) {
    await knex.schema.withSchema('commercial').alterTable('thot_chat_log', (t) => {
      t.smallint('feedback').notNullable().defaultTo(0); // 1 = 👍, -1 = 👎, 0 = sin voto
    });
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('thot_chat_log', 'promoted'))) {
    await knex.schema.withSchema('commercial').alterTable('thot_chat_log', (t) => {
      t.boolean('promoted').notNullable().defaultTo(false); // ya se volvió ejemplo dorado
    });
  }
};

/** No-op: un fix de columnas no debe soltarlas al revertir (las usa el feature). */
exports.down = async function () {};
