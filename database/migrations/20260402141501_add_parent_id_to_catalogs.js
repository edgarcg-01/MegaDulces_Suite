/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
    await knex.schema.alterTable("catalogs", (table) => {
        table.uuid("parent_id").references("id").inTable("catalogs").nullable().onDelete("CASCADE");
    });
}

exports.down = async function(knex) {
    await knex.schema.alterTable("catalogs", (table) => {
        table.dropColumn("parent_id");
    });
}
