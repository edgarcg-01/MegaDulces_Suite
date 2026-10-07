/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // 1. Tabla de Marcas
  await knex.schema.createTable('planograma_marcas', (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("nombre", 100).notNullable().unique();
    table.boolean("activo").defaultTo(true);
    table.integer("orden").defaultTo(0);
  });

  // 2. Tabla de Productos (Relacionada con Marcas)
  await knex.schema.createTable('planograma_productos', (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    // Relación con marcas
    table.uuid("marca_id")
      .references("id")
      .inTable("planograma_marcas")
      .onDelete("CASCADE");
      
    table.string("nombre", 150).notNullable();
    table.boolean("activo").defaultTo(true);
    table.integer("orden").defaultTo(0);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // El orden inverso es obligatorio por la llave foránea
  await knex.schema.dropTableIfExists('planograma_productos');
  await knex.schema.dropTableIfExists('planograma_marcas');
};