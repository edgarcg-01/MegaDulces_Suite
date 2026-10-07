exports.up = async function (knex) {
  await knex.schema.alterTable('daily_captures', (table) => {
    table.uuid('store_id').nullable().references('id').inTable('stores').onDelete('SET NULL');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('daily_captures', (table) => {
    table.dropColumn('store_id');
  });
};
