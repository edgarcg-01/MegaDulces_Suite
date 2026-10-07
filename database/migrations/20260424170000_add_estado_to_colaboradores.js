/**
 * @typedef {import('knex').Knex} Knex
 * @param {Knex} knex
 */
exports.up = async function(knex) {
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
