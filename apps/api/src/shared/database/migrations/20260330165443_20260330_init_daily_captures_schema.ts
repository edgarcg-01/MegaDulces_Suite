import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("daily_captures", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("user_id").notNullable();
    table.string("captured_by_username", 100).notNullable();
    table.string("zona_captura", 100).notNullable();
    table.date("fecha").notNullable();
    table.integer("num_visitas").notNullable().defaultTo(0);
    table.jsonb("visitas_data").notNullable();
    table.jsonb("stats").notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());

    // Asegura cero duplicados por dia para mismo user
    table.unique(["user_id", "fecha"]);
    table.index(["zona_captura"], "idx_daily_zona");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("daily_captures");
}
