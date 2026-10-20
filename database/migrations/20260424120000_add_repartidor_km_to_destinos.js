/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // [CI.LEGACY] Estas tablas de logística se crearon a mano en la base legacy; ninguna migración
  // las crea. Sobre una base vacía (el CI) no existen: se declara y no se hace nada. En la base
  // legacy existen y esta migración ya estaba aplicada, así que ahí no cambia nada.
  for (const t of ['logistica_catalogo_destinos']) {
    if (!(await knex.schema.hasTable(t))) {
      console.log(`[20260424120000_add_repartidor_km_to_destinos] NO MEDIDO: falta la tabla ${t} (creada a mano en la base legacy); se omite.`);
      return;
    }
  }
  return upOriginal(knex);
};

async function upOriginal(knex) {
  await knex.schema.alterTable('logistica_catalogo_destinos', (table) => {
    table.decimal('comision_repartidor', 12, 2).defaultTo(0);
    table.decimal('km', 12, 2).nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.alterTable('logistica_catalogo_destinos', (table) => {
    table.dropColumn('comision_repartidor');
    table.dropColumn('km');
  });
};
