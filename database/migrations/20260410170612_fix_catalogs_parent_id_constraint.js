/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
    // Eliminamos la restricción de llave foránea estricta en parent_id
    // para permitir que las Rutas apunten a IDs de la tabla 'zones'
    // sin que el motor de BD bloquee la operación por no estar en 'catalogs'.
    await knex.schema.alterTable("catalogs", (table) => {
        table.dropForeign("parent_id");
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
    await knex.schema.alterTable("catalogs", (table) => {
        table.uuid("parent_id").references("id").inTable("catalogs").nullable().onDelete("CASCADE").alter();
    });
};
