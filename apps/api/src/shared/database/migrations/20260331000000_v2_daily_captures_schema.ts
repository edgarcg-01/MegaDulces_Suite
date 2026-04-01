import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // 1. Borramos la tabla oríginal para eliminar permanentemente el UNIQUE Constraint
  await knex.schema.dropTableIfExists("daily_captures");

  // 2. Recreamos la tabla base adaptada al nuevo modulo de Angular
  await knex.schema.createTable("daily_captures", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("folio", 50).notNullable(); // Ej. U-31-153045
    table.uuid("user_id").notNullable();
    table.string("captured_by_username", 100).notNullable();
    table.string("zona_captura", 100).notNullable();
    table.date("fecha").notNullable();
    table.timestamp("hora_inicio").notNullable();
    table.timestamp("hora_fin").notNullable();
    table.jsonb("exhibiciones").notNullable().defaultTo('[]'); // Array contiene obj con fotoUrL
    table.jsonb("stats").notNullable().defaultTo('{}');
    table.timestamp("created_at").defaultTo(knex.fn.now());

    // Indizar para la búsqueda en "Reportes de Día" (próxima sección)
    table.index(["user_id", "fecha"], "idx_dc_user_fecha");
    table.index(["folio"], "idx_dc_folio");
    table.index(["fecha"], "idx_dc_fecha");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("daily_captures");
}
