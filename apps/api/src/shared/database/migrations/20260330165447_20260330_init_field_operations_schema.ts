import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("stores", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("nombre", 200).notNullable();
    table.text("direccion");
    table.string("zona", 100);
    table.decimal("latitud", 10, 7);
    table.decimal("longitud", 10, 7);
    table.boolean("activo").defaultTo(true);
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("visits", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("store_id").references("id").inTable("stores");
    table.uuid("user_id").notNullable();
    table.string("captured_by_username", 100).notNullable();
    table.timestamp("checkin_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("checkout_at");
    table.decimal("checkin_lat", 10, 7);
    table.decimal("checkin_lng", 10, 7);
    table.decimal("total_score", 10, 2).defaultTo(0);
    table.string("status", 20).defaultTo('in_progress');
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    table.index(["store_id"], "idx_visits_store");
    table.index(["user_id", "checkin_at"], "idx_visits_user_date");
    table.index(["status"], "idx_visits_status");
  });

  await knex.schema.createTable("exhibitions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("visit_id").references("id").inTable("visits").onDelete("CASCADE");
    table.string("posicion", 50).notNullable();
    table.string("tipo", 50).notNullable();
    table.string("nivel_ejecucion", 20).notNullable();
    table.decimal("score", 10, 2).defaultTo(0).notNullable();
    table.text("notas");
    table.timestamp("created_at").defaultTo(knex.fn.now());
    
    table.index(["visit_id"], "idx_exhibitions_visit");
  });

  await knex.schema.createTable("exhibition_photos", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("exhibition_id").references("id").inTable("exhibitions").onDelete("CASCADE");
    table.text("photo_url").notNullable();
    table.integer("orden").defaultTo(0);
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("exhibition_photos");
  await knex.schema.dropTableIfExists("exhibitions");
  await knex.schema.dropTableIfExists("visits");
  await knex.schema.dropTableIfExists("stores");
}
