exports.up = async function (knex) {
  await knex.schema.alterTable('stores', (table) => {
    table.uuid('ruta_id').nullable().references('id').inTable('catalogs').onDelete('SET NULL');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('stores', (table) => {
    table.dropColumn('ruta_id');
  });
};
