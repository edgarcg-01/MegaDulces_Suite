import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("planograma_marcas", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("nombre", 100).notNullable().unique();
    table.boolean("activo").defaultTo(true);
    table.integer("orden").defaultTo(0);
  });

  await knex.schema.createTable("planograma_productos", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("marca_id").references("id").inTable("planograma_marcas").onDelete("CASCADE");
    table.string("nombre", 150).notNullable();
    table.boolean("activo").defaultTo(true);
    table.integer("orden").defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("planograma_productos");
  await knex.schema.dropTableIfExists("planograma_marcas");
}
