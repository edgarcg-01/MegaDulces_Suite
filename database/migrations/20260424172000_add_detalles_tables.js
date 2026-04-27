/**
 * @typedef {import('knex').Knex} Knex
 * @param {Knex} knex
 */
exports.up = async function(knex) {
  // Crear tabla logistica_detalles_carga si no existe
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS logistica_detalles_carga (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      embarque_id UUID REFERENCES logistica_embarques(id) ON DELETE CASCADE,
      colaborador_id UUID REFERENCES logistica_colaboradores(id),
      tarifa DECIMAL(12, 2) DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Crear tabla logistica_detalles_descarga si no existe
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS logistica_detalles_descarga (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      embarque_id UUID REFERENCES logistica_embarques(id) ON DELETE CASCADE,
      colaborador_id UUID REFERENCES logistica_colaboradores(id),
      monto DECIMAL(12, 2) DEFAULT 0,
      tipo VARCHAR(50) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

/**
 * @param {Knex} knex
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('logistica_detalles_descarga');
  await knex.schema.dropTableIfExists('logistica_detalles_carga');
};
