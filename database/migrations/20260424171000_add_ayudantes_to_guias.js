/**
 * @typedef {import('knex').Knex} Knex
 * @param {Knex} knex
 */
exports.up = async function(knex) {
  // [CI.LEGACY] Estas tablas de logística se crearon a mano en la base legacy; ninguna migración
  // las crea. Sobre una base vacía (el CI) no existen: se declara y no se hace nada. En la base
  // legacy existen y esta migración ya estaba aplicada, así que ahí no cambia nada.
  for (const t of ['logistica_colaboradores','logistica_guias']) {
    if (!(await knex.schema.hasTable(t))) {
      console.log(`[20260424171000_add_ayudantes_to_guias] NO MEDIDO: falta la tabla ${t} (creada a mano en la base legacy); se omite.`);
      return;
    }
  }
  return upOriginal(knex);
};

async function upOriginal(knex) {
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
