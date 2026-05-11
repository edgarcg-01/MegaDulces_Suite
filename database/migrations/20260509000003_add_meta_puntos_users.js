/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Verificamos que la tabla exista antes de alterar
  const hasUsers = await knex.schema.hasTable('users');
  if (hasUsers) {
    await knex.schema.table('users', function(table) {
      // Usamos un valor defecto representativo de 5000 puntos para usuarios existentes
      table.integer('meta_puntos').defaultTo(5000).notNullable();
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  const hasUsers = await knex.schema.hasTable('users');
  if (hasUsers) {
    await knex.schema.table('users', function(table) {
      table.dropColumn('meta_puntos');
    });
  }
};
