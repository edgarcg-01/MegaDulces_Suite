/**
 * TC.5a (ADR-026) — Feedback loop de Thot Chat. Agrega 👍/👎 y `promoted` a la
 * bitácora para cosechar buenos intercambios como ejemplos verificados (TC.4a).
 * Aditiva, idempotente (guarda hasTable + hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_log'))) return;
  await knex.schema.withSchema('commercial').alterTable('thot_chat_log', async (t) => {
    if (!(await knex.schema.withSchema('commercial').hasColumn('thot_chat_log', 'feedback'))) {
      t.smallint('feedback').notNullable().defaultTo(0); // 1 = 👍, -1 = 👎, 0 = sin voto
    }
    if (!(await knex.schema.withSchema('commercial').hasColumn('thot_chat_log', 'promoted'))) {
      t.boolean('promoted').notNullable().defaultTo(false); // ya se volvió ejemplo dorado
    }
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_log'))) return;
  await knex.schema.withSchema('commercial').alterTable('thot_chat_log', (t) => {
    t.dropColumn('feedback');
    t.dropColumn('promoted');
  });
};
