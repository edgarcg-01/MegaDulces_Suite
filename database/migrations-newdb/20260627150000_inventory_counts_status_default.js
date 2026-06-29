/**
 * Higiene de estados (#13): el DEFAULT de inventory_counts.status era 'open', un
 * valor que la app nunca escribe (openCount inserta 'counting' explícito). Se
 * alinea el default a 'counting' para que un insert sin status no caiga en un
 * estado fantasma. Los valores 'open'/'ready_to_reconcile' siguen en el CHECK
 * (inofensivos, nunca escritos) — su remoción se difiere a una pasada con la
 * regression corriendo.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_counts'))) return;
  await knex.raw(`ALTER TABLE commercial.inventory_counts ALTER COLUMN status SET DEFAULT 'counting'`);
};

exports.down = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_counts'))) return;
  await knex.raw(`ALTER TABLE commercial.inventory_counts ALTER COLUMN status SET DEFAULT 'open'`);
};
