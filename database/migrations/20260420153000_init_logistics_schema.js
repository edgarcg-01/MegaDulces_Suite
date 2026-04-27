/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // 1. Catálogo de Destinos / Rutas
  await knex.schema.createTable('logistica_catalogo_destinos', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('nombre').notNullable().unique();
    table.decimal('comision_chofer', 12, 2).defaultTo(0);
    table.decimal('comision_ayudante', 12, 2).defaultTo(0);
    table.timestamps(true, true);
  });

  // 2. Colaboradores de Logística (pueden ser los mismos de la tabla 'users' pero con roles específicos)
  // Para este módulo, usaremos una tabla dedicada para perfiles logísticos específicos o vincularemos a 'users'.
  // Según el proto, tienen NSS y Roles (cargador/chofer/ayudante).
  await knex.schema.createTable('logistica_colaboradores', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('nombre').notNullable();
    table.specificType('roles', 'text[]').notNullable(); // ['chofer', 'ayudante', 'cargador']
    table.string('tipo').defaultTo('interno'); // interno / externo
    table.string('estado').defaultTo('activo');
    table.string('nss', 20);
    table.string('telefono', 20);
    table.timestamps(true, true);
  });

  // 3. Unidades / Flotilla
  await knex.schema.createTable('logistica_unidades', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('placa').notNullable().unique();
    table.string('modelo');
    table.decimal('rendimiento', 10, 2); // km/l
    table.integer('capacidad_cajas');
    table.decimal('capacidad_kg', 12, 2);
    table.string('estado').defaultTo('disponible');
    table.timestamps(true, true);
  });

  // 4. Períodos de Pago (Catorcenales)
  await knex.schema.createTable('logistica_periodos', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('numero').notNullable();
    table.date('inicio').notNullable();
    table.date('fin').notNullable();
    table.date('pago').notNullable();
    table.timestamps(true, true);
  });

  // 5. Embarques
  await knex.schema.createTable('logistica_embarques', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('folio').notNullable().unique();
    table.date('fecha').notNullable();
    table.uuid('unidad_id').references('id').inTable('logistica_unidades');
    table.string('origen');
    table.string('destino');
    table.integer('km');
    table.decimal('flete', 12, 2).defaultTo(0);
    table.decimal('valor_carga', 12, 2).defaultTo(0);
    table.integer('cajas').defaultTo(0);
    table.decimal('peso', 12, 2).defaultTo(0);
    table.string('tipo').defaultTo('entrega'); // entrega / traspaso / recoleccion
    table.string('estado').defaultTo('programado');
    table.text('observaciones');
    table.timestamps(true, true);
  });

  // 6. Guías
  await knex.schema.createTable('logistica_guias', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('numero').notNullable().unique();
    table.uuid('embarque_id').references('id').inTable('logistica_embarques').onDelete('CASCADE');
    table.string('tipo').defaultTo('entrega');
    table.string('estado').defaultTo('pendiente');
    table.uuid('chofer_id').references('id').inTable('logistica_colaboradores');
    table.decimal('comision_chofer', 12, 2).defaultTo(0);
    table.uuid('ayudante1_id').references('id').inTable('logistica_colaboradores');
    table.decimal('comision_ayudante1', 12, 2).defaultTo(0);
    table.uuid('ayudante2_id').references('id').inTable('logistica_colaboradores');
    table.decimal('comision_ayudante2', 12, 2).defaultTo(0);
    table.time('hora_salida');
    table.time('hora_llegada');
    table.boolean('duerme').defaultTo(false);
    table.decimal('viaticos_total', 12, 2).defaultTo(0);
    table.jsonb('viaticos_detalle'); // Desglose por persona y comida
    table.text('observaciones');
    table.timestamps(true, true);
  });

  // 7. Destinatarios de la Guía
  await knex.schema.createTable('logistica_guias_destinatarios', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('guia_id').references('id').inTable('logistica_guias').onDelete('CASCADE');
    table.string('cliente').notNullable();
    table.string('direccion');
    table.integer('cajas').defaultTo(0);
    table.decimal('peso', 10, 2).defaultTo(0);
    table.decimal('valor', 12, 2).defaultTo(0);
    table.string('estado').defaultTo('pendiente');
    table.timestamps(true, true);
  });

  // 8. Costos del Viaje
  await knex.schema.createTable('logistica_costos', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('embarque_id').references('id').inTable('logistica_embarques').onDelete('CASCADE');
    table.decimal('combustible', 12, 2).defaultTo(0);
    table.decimal('casetas', 12, 2).defaultTo(0);
    table.decimal('hospedaje', 12, 2).defaultTo(0);
    table.decimal('pensiones', 12, 2).defaultTo(0);
    table.decimal('permisos', 12, 2).defaultTo(0);
    table.decimal('talachas', 12, 2).defaultTo(0);
    table.decimal('ayudantes_ext', 12, 2).defaultTo(0);
    table.decimal('maniobras', 12, 2).defaultTo(0);
    table.decimal('viaticos_guia', 12, 2).defaultTo(0);
    table.decimal('otros', 12, 2).defaultTo(0);
    table.decimal('subtotal_operativo', 12, 2).defaultTo(0);
    table.decimal('costo_fijo_km', 12, 2).defaultTo(0);
    table.decimal('total', 12, 2).defaultTo(0);
    table.text('observaciones');
    table.timestamps(true, true);
  });

  // 9. Detalles de Carga (Salida)
  await knex.schema.createTable('logistica_detalles_carga', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('embarque_id').references('id').inTable('logistica_embarques').onDelete('CASCADE');
    table.uuid('colaborador_id').references('id').inTable('logistica_colaboradores');
    table.decimal('tarifa', 12, 2).defaultTo(0);
    table.timestamps(true, true);
  });

  // 10. Detalles de Descarga (Regreso / LAB)
  await knex.schema.createTable('logistica_detalles_descarga', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('embarque_id').references('id').inTable('logistica_embarques').onDelete('CASCADE');
    table.uuid('colaborador_id').references('id').inTable('logistica_colaboradores');
    table.decimal('monto', 12, 2).defaultTo(0);
    table.string('tipo').notNullable(); // 'regreso' / 'lab'
    table.timestamps(true, true);
  });

  // 11. Liquidaciones
  await knex.schema.createTable('logistica_liquidaciones', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('colaborador_id').references('id').inTable('logistica_colaboradores');
    table.uuid('periodo_id').references('id').inTable('logistica_periodos');
    table.decimal('viaticos', 12, 2).defaultTo(0);
    table.decimal('comisiones', 12, 2).defaultTo(0);
    table.decimal('cargas_maniobras', 12, 2).defaultTo(0);
    table.decimal('bonos', 12, 2).defaultTo(0);
    table.decimal('deducciones', 12, 2).defaultTo(0);
    table.decimal('subtotal', 12, 2).defaultTo(0);
    table.decimal('neto', 12, 2).defaultTo(0);
    table.text('notas');
    table.timestamps(true, true);
  });
  // 12. Factores y Costos por Unidad
  await knex.schema.createTable('logistica_config_finanzas', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('clave').notNullable().unique(); // 'factor_jalisco', 'costo_km_international', etc.
    table.string('categoria').notNullable(); // 'factor', 'costo_km', 'tarifa_maniobra'
    table.string('descripcion');
    table.decimal('valor', 12, 4).notNullable();
    table.timestamps(true, true);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('logistica_config_finanzas');
  await knex.schema.dropTableIfExists('logistica_liquidaciones');
  await knex.schema.dropTableIfExists('logistica_detalles_descarga');
  await knex.schema.dropTableIfExists('logistica_detalles_carga');
  await knex.schema.dropTableIfExists('logistica_costos');
  await knex.schema.dropTableIfExists('logistica_guias_destinatarios');
  await knex.schema.dropTableIfExists('logistica_guias');
  await knex.schema.dropTableIfExists('logistica_embarques');
  await knex.schema.dropTableIfExists('logistica_periodos');
  await knex.schema.dropTableIfExists('logistica_unidades');
  await knex.schema.dropTableIfExists('logistica_colaboradores');
  await knex.schema.dropTableIfExists('logistica_catalogo_destinos');
};
