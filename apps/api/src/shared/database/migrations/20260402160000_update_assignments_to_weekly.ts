import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // 1. Limpiar datos viejos ya que el cambio es estructural y rompe la lógica de fechas
  await knex("daily_assignments").del();

  await knex.schema.alterTable("daily_assignments", (table) => {
    table.dropUnique(["user_id", "date"]);
    table.dropColumn("date");
    table.integer("day_of_week").notNullable(); // 1=Lun, 2=Mar, 3=Mie, 4=Jue, 5=Vie, 6=Sab, 7=Dom
    
    table.unique(["user_id", "day_of_week"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("daily_assignments", (table) => {
    table.dropUnique(["user_id", "day_of_week"]);
    table.dropColumn("day_of_week");
    table.date("date").notNullable().defaultTo(knex.fn.now());
    
    table.unique(["user_id", "date"]);
  });
}
