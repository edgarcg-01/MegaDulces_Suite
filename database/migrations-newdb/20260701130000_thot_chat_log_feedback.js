/**
 * TC.5a (ADR-026) — Feedback loop de Thot Chat. Agrega 👍/👎 y `promoted` a la
 * bitácora para cosechar buenos intercambios como ejemplos verificados (TC.4a).
 * Aditiva, idempotente (guarda hasTable + hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_log'))) return;
  // El builder de knex es SINCRONO: los `hasColumn` van ANTES del alterTable, no
  // dentro de un callback async (asi no agregaba las columnas y, en una DB limpia,
  // reventaba con "Transaction query already complete"). Ver hotfix 20260724150000.
  const hasFeedback = await knex.schema.withSchema('commercial').hasColumn('thot_chat_log', 'feedback');
  const hasPromoted = await knex.schema.withSchema('commercial').hasColumn('thot_chat_log', 'promoted');
  if (hasFeedback && hasPromoted) return;
  await knex.schema.withSchema('commercial').alterTable('thot_chat_log', (t) => {
    if (!hasFeedback) t.smallint('feedback').notNullable().defaultTo(0); // 1 = up, -1 = down, 0 = sin voto
    if (!hasPromoted) t.boolean('promoted').notNullable().defaultTo(false); // ya se volvio ejemplo dorado
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_log'))) return;
  await knex.schema.withSchema('commercial').alterTable('thot_chat_log', (t) => {
    t.dropColumn('feedback');
    t.dropColumn('promoted');
  });
};
