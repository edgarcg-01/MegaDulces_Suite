/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.schema.createTable("scoring_config", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.jsonb("config").notNullable().defaultTo(JSON.stringify({
      pesos_posicion: { caja: 100, adyacente: 70, vitrina: 60, exhibidor: 50, refrigerador: 40, anaquel: 25, detras: 10 },
      factores_tipo: { exhibidor: 2.0, refrigerador: 1.8, vitrina: 1.5, tira: 1.0 },
      niveles_ejecucion: { alto: 1.0, medio: 0.7, bajo: 0.4 }
    }));
    table.timestamp("updated_at").defaultTo(knex.fn.now());
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists("scoring_config");
}
