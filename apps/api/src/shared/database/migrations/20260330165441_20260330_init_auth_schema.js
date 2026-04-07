/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Aseguramos que la extensión para UUIDs esté activa en PostgreSQL
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // 1. role_permissions
  await knex.schema.createTable('role_permissions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('role_name', 50).notNullable().unique();
    table.jsonb('permissions').notNullable().defaultTo('{}');
  });

  // 2. users
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('username', 100).notNullable().unique();
    table.string('password_hash', 255).notNullable();
    table.string('nombre', 150);
    table.string('zona', 100);
    // Relación por nombre de rol
    table.string('role_name', 50).references('role_name').inTable('role_permissions');
    table.boolean('activo').defaultTo(true);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // El orden inverso es vital por las llaves foráneas
  // 1. users
  await knex.schema.dropTableIfExists('users');
  // 2. role_permissions
  await knex.schema.dropTableIfExists('role_permissions');
};