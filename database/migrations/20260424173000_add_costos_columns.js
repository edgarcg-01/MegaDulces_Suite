/**
 * @typedef {import('knex').Knex} Knex
 * @param {Knex} knex
 */
exports.up = async function(knex) {
  // Agregar columnas faltantes a logistica_costos
  const columns = [
    { name: 'ayudantes_ext', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS ayudantes_ext DECIMAL(12, 2) DEFAULT 0' },
    { name: 'casetas', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS casetas DECIMAL(12, 2) DEFAULT 0' },
    { name: 'combustible', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS combustible DECIMAL(12, 2) DEFAULT 0' },
    { name: 'costo_fijo_km', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS costo_fijo_km DECIMAL(12, 2) DEFAULT 0' },
    { name: 'hospedaje', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS hospedaje DECIMAL(12, 2) DEFAULT 0' },
    { name: 'maniobras', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS maniobras DECIMAL(12, 2) DEFAULT 0' },
    { name: 'otros', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS otros DECIMAL(12, 2) DEFAULT 0' },
    { name: 'pensiones', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS pensiones DECIMAL(12, 2) DEFAULT 0' },
    { name: 'permisos', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS permisos DECIMAL(12, 2) DEFAULT 0' },
    { name: 'subtotal_operativo', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS subtotal_operativo DECIMAL(12, 2) DEFAULT 0' },
    { name: 'talachas', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS talachas DECIMAL(12, 2) DEFAULT 0' },
    { name: 'total', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS total DECIMAL(12, 2) DEFAULT 0' },
    { name: 'viaticos_guia', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS viaticos_guia DECIMAL(12, 2) DEFAULT 0' },
    { name: 'observaciones', sql: 'ALTER TABLE logistica_costos ADD COLUMN IF NOT EXISTS observaciones TEXT' }
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
  await knex.schema.alterTable('logistica_costos', (table) => {
    table.dropColumn('ayudantes_ext');
    table.dropColumn('casetas');
    table.dropColumn('combustible');
    table.dropColumn('costo_fijo_km');
    table.dropColumn('hospedaje');
    table.dropColumn('maniobras');
    table.dropColumn('otros');
    table.dropColumn('pensiones');
    table.dropColumn('permisos');
    table.dropColumn('subtotal_operativo');
    table.dropColumn('talachas');
    table.dropColumn('total');
    table.dropColumn('viaticos_guia');
    table.dropColumn('observaciones');
  });
};
