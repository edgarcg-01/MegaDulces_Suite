/**
 * @typedef {import('knex').Knex} Knex
 * @param {Knex} knex
 */
exports.up = async function(knex) {
  // [CI.LEGACY] Estas tablas de logística se crearon a mano en la base legacy; ninguna migración
  // las crea. Sobre una base vacía (el CI) no existen: se declara y no se hace nada. En la base
  // legacy existen y esta migración ya estaba aplicada, así que ahí no cambia nada.
  for (const t of ['logistica_colaboradores']) {
    if (!(await knex.schema.hasTable(t))) {
      console.log(`[20260424170000_add_estado_to_colaboradores] NO MEDIDO: falta la tabla ${t} (creada a mano en la base legacy); se omite.`);
      return;
    }
  }
  return upOriginal(knex);
};

async function upOriginal(knex) {
  // Agregar columnas faltantes a logistica_colaboradores
  const columns = [
    { name: 'estado', sql: 'ALTER TABLE logistica_colaboradores ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT \'activo\'' },
    { name: 'nss', sql: 'ALTER TABLE logistica_colaboradores ADD COLUMN IF NOT EXISTS nss VARCHAR(20)' },
    { name: 'telefono', sql: 'ALTER TABLE logistica_colaboradores ADD COLUMN IF NOT EXISTS telefono VARCHAR(20)' },
    { name: 'tipo', sql: 'ALTER TABLE logistica_colaboradores ADD COLUMN IF NOT EXISTS tipo VARCHAR(50) DEFAULT \'interno\'' }
  ];

  for (const column of columns) {
    try {
      await knex.raw(column.sql);
    } catch (error) {
      console.log(`Column ${column.name} might already exist, continuing...`);
    }
  }
};

/**
 * @param {Knex} knex
 */
exports.down = async function(knex) {
  await knex.schema.alterTable('logistica_colaboradores', (table) => {
    table.dropColumn('estado');
    table.dropColumn('nss');
    table.dropColumn('telefono');
    table.dropColumn('tipo');
  });
};
