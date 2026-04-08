/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // 1. Limpiar datos viejos ya que el cambio es estructural
  await knex("daily_assignments").del();

  await knex.schema.alterTable("daily_assignments", (table) => {
    // 2. Eliminar restricción y columna vieja
    table.dropUnique(["user_id", "date"]);
    table.dropColumn("date");
    
    // 3. Agregar nueva lógica de día de la semana (1-7)
    table.integer("day_of_week").notNullable(); 
    
    // 4. Nueva restricción: Un usuario solo tiene una asignación por día de la semana
    table.unique(["user_id", "day_of_week"]);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // Limpiar para evitar conflictos de nulidad al revertir
  await knex("daily_assignments").del();

  await knex.schema.alterTable("daily_assignments", (table) => {
    table.dropUnique(["user_id", "day_of_week"]);
    table.dropColumn("day_of_week");
    
    // Al volver a 'date', usamos defaultTo para que Postgres no proteste por los nulos
    table.date("date").notNullable().defaultTo(knex.fn.now());
    
    table.unique(["user_id", "date"]);
  });
};