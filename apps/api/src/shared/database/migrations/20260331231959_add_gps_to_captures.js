/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
    await knex.schema.alterTable("daily_captures", (table) => {
        table.decimal("latitud", 10, 8).nullable();
        table.decimal("longitud", 11, 8).nullable();
    });
  };


/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.alterTable("daily_captures", (table) => {
    table.dropColumn("latitud");
    table.dropColumn("longitud");
  });
}
