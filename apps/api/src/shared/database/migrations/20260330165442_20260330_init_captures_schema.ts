import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("captures", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("folio", 50).notNullable().unique();
    table.uuid("user_id").notNullable();
    table.string("captured_by_username", 100).notNullable();
    table.string("zona_captura", 100).notNullable();
    table.jsonb("kpis_data").notNullable();
    table.timestamp("fecha_captura").defaultTo(knex.fn.now());

    // Temporal FK for referential integrity logic 
    table.foreign("user_id").references("id").inTable("users").onDelete("RESTRICT");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("captures");
}
