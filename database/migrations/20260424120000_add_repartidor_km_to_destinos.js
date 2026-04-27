/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.schema.alterTable('logistica_catalogo_destinos', (table) => {
    table.decimal('comision_repartidor', 12, 2).defaultTo(0);
    table.decimal('km', 12, 2).nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.alterTable('logistica_catalogo_destinos', (table) => {
    table.dropColumn('comision_repartidor');
    table.dropColumn('km');
  });
};
