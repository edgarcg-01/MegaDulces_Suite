/**
 * @typedef {import('knex').Knex} Knex
 * @param {Knex} knex
 */
exports.up = async function(knex) {
  // Agregar columnas de ayudantes a logistica_guias
  const columns = [
    { name: 'ayudante1_id', sql: 'ALTER TABLE logistica_guias ADD COLUMN IF NOT EXISTS ayudante1_id UUID REFERENCES logistica_colaboradores(id)' },
    { name: 'ayudante2_id', sql: 'ALTER TABLE logistica_guias ADD COLUMN IF NOT EXISTS ayudante2_id UUID REFERENCES logistica_colaboradores(id)' }
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
  await knex.schema.alterTable('logistica_guias', (table) => {
    table.dropColumn('ayudante1_id');
    table.dropColumn('ayudante2_id');
  });
};
