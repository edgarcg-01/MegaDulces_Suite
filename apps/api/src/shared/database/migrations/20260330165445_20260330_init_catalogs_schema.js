/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.schema.createTable("catalogs", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("catalog_id", 50).notNullable();
    table.string("value", 200).notNullable();
    table.integer("orden").defaultTo(0);
    table.unique(["catalog_id", "value"]);
    table.index(["catalog_id"], "idx_catalogs_type");
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists("catalogs");
}
