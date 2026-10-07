/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Opcional: Asegurar pgcrypto si esta migración corre sola
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  await knex.schema.createTable('captures', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string("folio", 50).notNullable().unique();
    table.uuid("user_id").notNullable();
    table.string("captured_by_username", 100).notNullable();
    table.string("zona_captura", 100).notNullable();
    table.jsonb("kpis_data").notNullable();
    table.timestamp("fecha_captura").defaultTo(knex.fn.now());

    // Llave foránea hacia la tabla de usuarios
    table.foreign("user_id")
      .references("id")
      .inTable("users")
      .onDelete("RESTRICT");
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists("captures");
};