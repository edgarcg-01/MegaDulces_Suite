/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
    await knex.schema.createTable("daily_assignments", (table) => {
        table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
        table.uuid("user_id").references("id").inTable("users").notNullable().onDelete("CASCADE");
        table.uuid("route_id").references("id").inTable("catalogs").notNullable();
        table.uuid("assigned_by").references("id").inTable("users").nullable();
        table.date("date").notNullable().defaultTo(knex.fn.now());
        table.string("status", 20).defaultTo("pendiente"); // pendiente, completado, cancelado
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    table.unique(["user_id", "date"]); // Un colaborador solo tiene una ruta por día
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
    await knex.schema.dropTableIfExists("daily_assignments");
}
