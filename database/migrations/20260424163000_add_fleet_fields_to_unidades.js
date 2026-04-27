/**
 * @typedef {import('knex').Knex} Knex
 * @param {Knex} knex
 */
exports.up = async function(knex) {
  // Agregar columnas individualmente para evitar errores si ya existen
  const columns = [
    { name: 'marca', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS marca VARCHAR(255)' },
    { name: 'anio', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS anio INTEGER' },
    { name: 'numero_serie', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS numero_serie VARCHAR(255)' },
    { name: 'numero_motor', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS numero_motor VARCHAR(255)' },
    { name: 'km_actual', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS km_actual DECIMAL(12, 2) DEFAULT 0' },
    { name: 'rendimiento_kml', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS rendimiento_kml DECIMAL(10, 2)' },
    { name: 'ultimo_mantenimiento', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS ultimo_mantenimiento DATE' },
    { name: 'proximo_mantenimiento', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS proximo_mantenimiento DATE' },
    { name: 'km_mantenimiento', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS km_mantenimiento INTEGER DEFAULT 5000' },
    { name: 'observaciones', sql: 'ALTER TABLE logistica_unidades ADD COLUMN IF NOT EXISTS observaciones TEXT' }
  ];

  for (const column of columns) {
    try {
      await knex.raw(column.sql);
    } catch (error) {
      // Ignorar error si la columna ya existe
      console.log(`Column ${column.name} might already exist, continuing...`);
    }
  }
};

/**
 * @param {Knex} knex
 */
exports.down = async function(knex) {
  await knex.schema.alterTable('logistica_unidades', (table) => {
    table.dropColumn('marca');
    table.dropColumn('anio');
    table.dropColumn('tipo');
    table.dropColumn('numero_serie');
    table.dropColumn('numero_motor');
    table.dropColumn('km_actual');
    table.dropColumn('rendimiento_kml');
    table.dropColumn('ultimo_mantenimiento');
    table.dropColumn('proximo_mantenimiento');
    table.dropColumn('km_mantenimiento');
    table.dropColumn('observaciones');
  });
};
