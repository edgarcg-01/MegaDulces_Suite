/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema
    // Tabla de checklists para inspecciones y llegadas
    .createTable('logistica_checklists', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('embarque_id').references('id').inTable('logistica_embarques').onDelete('CASCADE');
      table.string('tipo', 50).notNull(); // 'inspeccion_salida' o 'llegada'
      table.jsonb('items').notNull(); // Array de {id, nombre, completado, observaciones}
      table.boolean('completado').defaultTo(false);
      table.timestamp('fecha_creacion').defaultTo(knex.fn.now());
      table.timestamp('fecha_completado');
      table.uuid('creado_por').references('id').inTable('users');
      table.timestamps(true, true);
      
      table.index('embarque_id');
      table.index('tipo');
      table.index('creado_por');
    })
    // Tabla de fotos de entrega
    .createTable('logistica_fotos_entrega', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('embarque_id').references('id').inTable('logistica_embarques').onDelete('CASCADE');
      table.string('url', 500).notNull();
      table.string('public_id', 500); // Cloudinary public_id
      table.text('descripcion');
      table.timestamp('fecha_subida').defaultTo(knex.fn.now());
      table.uuid('subido_por').references('id').inTable('users');
      table.timestamps(true, true);
      
      table.index('embarque_id');
      table.index('subido_por');
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('logistica_fotos_entrega')
    .dropTableIfExists('logistica_checklists');
};
