import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("daily_captures", (table) => {
    table.decimal("latitud", 10, 8).nullable();
    table.decimal("longitud", 11, 8).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("daily_captures", (table) => {
    table.dropColumn("latitud");
    table.dropColumn("longitud");
  });
}
