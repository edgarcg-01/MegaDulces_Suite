import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // role_permissions
  await knex.schema.createTable("role_permissions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("role_name", 50).notNullable().unique();
    table.jsonb("permissions").notNullable().defaultTo("{}");
  });

  // users
  await knex.schema.createTable("users", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("username", 100).notNullable().unique();
    table.string("password_hash", 255).notNullable();
    table.string("nombre", 150);
    table.string("zona", 100);
    table.string("role_name", 50).references("role_name").inTable("role_permissions");
    table.boolean("activo").defaultTo(true);
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("users");
  await knex.schema.dropTableIfExists("role_permissions");
}
