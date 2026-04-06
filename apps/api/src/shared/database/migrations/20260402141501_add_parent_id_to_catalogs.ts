import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("catalogs", (table) => {
    table.uuid("parent_id").references("id").inTable("catalogs").nullable().onDelete("CASCADE");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("catalogs", (table) => {
    table.dropColumn("parent_id");
  });
}
