/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // [CI.LEGACY] Estas tablas de logística se crearon a mano en la base legacy; ninguna migración
  // las crea. Sobre una base vacía (el CI) no existen: se declara y no se hace nada. En la base
  // legacy existen y esta migración ya estaba aplicada, así que ahí no cambia nada.
  for (const t of ['logistica_colaboradores']) {
    if (!(await knex.schema.hasTable(t))) {
      console.log(`[20260427000001_link_users_to_colaboradores] NO MEDIDO: falta la tabla ${t} (creada a mano en la base legacy); se omite.`);
      return;
    }
  }
  return upOriginal(knex);
};

async function upOriginal(knex) {
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
