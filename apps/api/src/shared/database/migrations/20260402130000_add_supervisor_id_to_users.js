/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
    await knex.schema.alterTable('users', (table) => {
        table.uuid('supervisor_id').nullable().references('id').inTable('users');
    });
}

exports.down = async function(knex) {
    await knex.schema.alterTable('users', (table) => {
        table.dropColumn('supervisor_id');
    });
}
