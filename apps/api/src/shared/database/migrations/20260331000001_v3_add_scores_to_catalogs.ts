import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // 1. Modificar tabla de catálogos para soportar iconos y puntuación (Conceptos/Ubicaciones)
  await knex.schema.alterTable("catalogs", (table) => {
    table.integer("puntuacion").defaultTo(0);
    table.string("icono", 100).nullable();
  });

  // 2. Modificar tabla de productos para soportar puntuación individual
  await knex.schema.alterTable("planograma_productos", (table) => {
    table.integer("puntuacion").defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("catalogs", (table) => {
    table.dropColumn("puntuacion");
    table.dropColumn("icono");
  });

  await knex.schema.alterTable("planograma_productos", (table) => {
    table.dropColumn("puntuacion");
  });
}
