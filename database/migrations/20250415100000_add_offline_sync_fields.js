/**
 * Migration: Add offline sync fields to daily_captures table
 * Includes UUID for idempotency, geolocation validation flags, and fraud detection
 */

exports.up = function(knex) {
  return knex.schema.table('daily_captures', table => {
    // UUID para idempotencia en sincronización offline
    table.uuid('sync_uuid').unique().index();
    
    // Campos de validación de geolocalización
    table.decimal('distancia_tienda', 8, 2).nullable(); // Distancia en metros
    table.enum('confianza_ubicacion', ['alta', 'media', 'baja']).defaultTo('alta');
    
    // Flags de fraude (frontend + backend)
    table.boolean('flag_fraude_frontend').defaultTo(false);
    table.boolean('flag_fraude_backend').defaultTo(false);
    
    // Campos para auditoría
    table.boolean('flag_revisado_auditoria').defaultTo(false);
    table.timestamp('fecha_revision_auditoria').nullable();
    table.text('notas_auditoria').nullable();
    
    // Campos de sincronización
    table.integer('intentos_sincronizacion').defaultTo(0);
    table.timestamp('fecha_creacion_dispositivo').nullable();
    table.timestamp('fecha_sincronizacion').nullable();
    
    // Índice compuesto para consultas de fraude
    table.index(['flag_fraude_backend', 'flag_fraude_frontend']);
    table.index(['sync_uuid', 'user_id']);
  })
  .then(() => {
    // Crear tabla de logs de sincronización para auditoría
    return knex.schema.createTable('sync_logs', table => {
      table.uuid('id').primary().defaultTo(knex.fn.uuid());
      table.uuid('visita_id').references('id').inTable('daily_captures').onDelete('SET NULL');
      table.uuid('sync_uuid').notNullable();
      table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
      table.enum('estado', ['exitoso', 'error', 'duplicado']).notNullable();
      table.jsonb('detalles').nullable();
      table.timestamp('fecha').defaultTo(knex.fn.now());
      
      // Índices para consultas frecuentes
      table.index('sync_uuid');
      table.index('user_id');
      table.index('estado');
      table.index('fecha');
    });
  })
  .then(() => {
    // Crear tabla de tiendas con coordenadas (si no existe)
    return knex.schema.hasTable('tiendas').then(exists => {
      if (!exists) {
        return knex.schema.createTable('tiendas', table => {
          table.uuid('id').primary().defaultTo(knex.fn.uuid());
          table.string('nombre', 255).notNullable();
          table.string('direccion', 500).nullable();
          table.string('zona', 100).nullable();
          table.decimal('latitud', 10, 8).nullable();
          table.decimal('longitud', 11, 8).nullable();
          table.string('telefono', 50).nullable();
          table.string('email', 100).nullable();
          table.text('notas').nullable();
          table.boolean('activo').defaultTo(true);
          table.timestamps(true, true);
          
          // Índices geoespaciales
          table.index(['latitud', 'longitud']);
          table.index('zona');
          table.index('activo');
        });
      }
    });
  });
};

exports.down = function(knex) {
  return knex.schema.table('daily_captures', table => {
    table.dropColumns(
      'sync_uuid',
      'distancia_tienda',
      'confianza_ubicacion',
      'flag_fraude_frontend',
      'flag_fraude_backend',
      'flag_revisado_auditoria',
      'fecha_revision_auditoria',
      'notas_auditoria',
      'intentos_sincronizacion',
      'fecha_creacion_dispositivo',
      'fecha_sincronizacion'
    );
    table.dropIndex(['flag_fraude_backend', 'flag_fraude_frontend']);
    table.dropIndex(['sync_uuid', 'user_id']);
  })
  .then(() => knex.schema.dropTableIfExists('sync_logs'))
  .then(() => knex.schema.dropTableIfExists('tiendas'));
};
