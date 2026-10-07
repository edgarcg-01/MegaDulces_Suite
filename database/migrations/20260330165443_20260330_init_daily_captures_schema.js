/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Asegurar que la extensión de UUID exista
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  await knex.schema.createTable('daily_captures', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    
    // Definimos la columna limpia primero
    table.uuid('user_id').notNullable();
    
    table.string('captured_by_username', 100).notNullable();
    table.string('zona_captura', 100).notNullable();
    table.date('fecha').notNullable();
    table.integer('num_visitas').notNullable().defaultTo(0);
    table.jsonb('visitas_data').notNullable();
    table.jsonb('stats').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    // --- RESTRICCIONES E ÍNDICES ---
    
    // 1. Relación: Si se borra el usuario, se borran sus capturas diarias
    table.foreign('user_id')
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');

    // 2. Evita duplicados: Un usuario solo puede tener un registro por fecha
    table.unique(['user_id', 'fecha']);
    
    // 3. Índice para búsquedas rápidas por zona
    table.index(['zona_captura'], 'idx_daily_zona');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('daily_captures');
};