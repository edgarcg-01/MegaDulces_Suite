import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // Rename tables
  await knex.schema.renameTable("planograma_marcas", "brands");
  await knex.schema.renameTable("planograma_productos", "products");

  // Rename columns if needed
  await knex.schema.alterTable("products", (table) => {
    table.renameColumn("marca_id", "brand_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("products", (table) => {
    table.renameColumn("brand_id", "marca_id");
  });
  await knex.schema.renameTable("products", "planograma_productos");
  await knex.schema.renameTable("brands", "planograma_marcas");
}
