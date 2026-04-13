/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Change puntuacion from integer to decimal to support decimal values (0.7, 1.2, etc.)
  await knex.schema.alterTable("catalogs", (table) => {
    table.decimal("puntuacion", 5, 2).defaultTo(0.0).alter();
  });

  // Also update products table if needed
  await knex.schema.alterTable("products", (table) => {
    table.decimal("puntuacion", 5, 2).defaultTo(0.0).alter();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // Revert back to integer
  await knex.schema.alterTable("catalogs", (table) => {
    table.integer("puntuacion").defaultTo(0).alter();
  });

  await knex.schema.alterTable("products", (table) => {
    table.integer("puntuacion").defaultTo(0).alter();
  });
};
