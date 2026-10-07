/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Agregar user_id a logistica_colaboradores para relacionar con users
  await knex.schema.alterTable('logistica_colaboradores', (table) => {
    table.uuid('user_id').nullable();
    table.foreign('user_id')
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.alterTable('logistica_colaboradores', (table) => {
    table.dropForeign('logistica_colaboradores_user_id_foreign');
    table.dropColumn('user_id');
  });
};
