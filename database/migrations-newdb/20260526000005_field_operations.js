/**
 * Migración: tablas de operación en campo.
 *
 * Tablas creadas:
 *   1. stores             — puntos de venta del tenant
 *   2. daily_assignments  — asignación user → ruta semanal (1 por day_of_week)
 *   3. visits             — visitas a stores (check-in/check-out con GPS + score)
 *   4. exhibitions        — exhibiciones evaluadas dentro de una visit
 *   5. exhibition_photos  — fotos de exhibiciones (Cloudinary URLs)
 *
 * Cambios vs legacy (intencionalmente, aprovechando reset):
 *   - QUITAMOS `visits.captured_by_username` (deuda técnica audit finding 1.7).
 *     Si necesitás el username en una query, hacer JOIN con users.
 *   - RENOMBRAMOS `exhibitions.pertenece_mega_dulces` → `is_own_brand` por
 *     ser genérico multi-tenant (cada tenant tiene su propia "marca propia").
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // STORES — puntos de venta
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('stores', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.string('nombre', 200).notNullable();
    table.text('direccion');
    table.uuid('zona_id'); // composite FK abajo
    table.uuid('ruta_id'); // composite FK a catalogs (catalog_id='rutas')
    table.decimal('latitud', 10, 7);
    table.decimal('longitud', 10, 7);
    table.boolean('activo').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'stores_tenant_id_composite' });

    table.foreign(['tenant_id', 'zona_id'], 'fk_stores_tenant_zona')
      .references(['tenant_id', 'id']).inTable('zones').onDelete('SET NULL');
    table.foreign(['tenant_id', 'ruta_id'], 'fk_stores_tenant_ruta')
      .references(['tenant_id', 'id']).inTable('catalogs').onDelete('SET NULL');

    table.index('tenant_id', 'idx_stores_tenant');
    table.index(['tenant_id', 'zona_id'], 'idx_stores_tenant_zona');
    table.index(['tenant_id', 'ruta_id'], 'idx_stores_tenant_ruta');
    table.index(['tenant_id', 'activo'], 'idx_stores_tenant_activo');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DAILY_ASSIGNMENTS — agenda semanal user → ruta (route_id apunta a catalogs)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('daily_assignments', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('user_id').notNullable();
    table.uuid('route_id').notNullable(); // FK a catalogs(id) con catalog_id='rutas'
    table.uuid('assigned_by');
    table.integer('day_of_week').notNullable(); // 1=Lunes ... 7=Domingo (ISO 8601)
    table.string('status', 20).notNullable().defaultTo('pendiente'); // pendiente | completado | cancelado
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'user_id', 'day_of_week'], { indexName: 'daily_assignments_tenant_user_dow_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'daily_assignments_tenant_id_composite' });

    table.foreign(['tenant_id', 'user_id'], 'fk_daily_assignments_tenant_user')
      .references(['tenant_id', 'id']).inTable('users').onDelete('CASCADE');
    table.foreign(['tenant_id', 'route_id'], 'fk_daily_assignments_tenant_route')
      .references(['tenant_id', 'id']).inTable('catalogs').onDelete('RESTRICT');
    table.foreign(['tenant_id', 'assigned_by'], 'fk_daily_assignments_tenant_assigned_by')
      .references(['tenant_id', 'id']).inTable('users').onDelete('SET NULL');

    // CHECK constraint: day_of_week debe estar en 1-7
    table.check('?? BETWEEN 1 AND 7', ['day_of_week'], 'daily_assignments_dow_range');

    table.index('tenant_id', 'idx_daily_assignments_tenant');
    table.index(['tenant_id', 'user_id'], 'idx_daily_assignments_tenant_user');
    table.index(['tenant_id', 'day_of_week'], 'idx_daily_assignments_tenant_dow');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VISITS — check-in/check-out a un store con GPS
  // QUITAMOS captured_by_username (deuda técnica audit 1.7).
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('visits', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('store_id').notNullable();
    table.uuid('user_id').notNullable();
    table.timestamp('checkin_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('checkout_at');
    table.decimal('checkin_lat', 10, 7);
    table.decimal('checkin_lng', 10, 7);
    table.decimal('total_score', 10, 2).notNullable().defaultTo(0);
    table.string('status', 20).notNullable().defaultTo('in_progress'); // in_progress | completed | cancelled
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'visits_tenant_id_composite' });

    table.foreign(['tenant_id', 'store_id'], 'fk_visits_tenant_store')
      .references(['tenant_id', 'id']).inTable('stores').onDelete('RESTRICT');
    table.foreign(['tenant_id', 'user_id'], 'fk_visits_tenant_user')
      .references(['tenant_id', 'id']).inTable('users').onDelete('RESTRICT');

    table.index('tenant_id', 'idx_visits_tenant');
    table.index(['tenant_id', 'store_id'], 'idx_visits_tenant_store');
    table.index(['tenant_id', 'user_id', 'checkin_at'], 'idx_visits_tenant_user_date');
    table.index(['tenant_id', 'status'], 'idx_visits_tenant_status');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EXHIBITIONS — evaluaciones de exhibición dentro de una visita
  // Renombrado: pertenece_mega_dulces → is_own_brand (multi-tenant friendly)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('exhibitions', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('visit_id').notNullable();
    table.string('posicion', 50).notNullable();
    table.string('tipo', 50).notNullable();
    table.string('nivel_ejecucion', 20).notNullable();
    table.decimal('score', 10, 2).notNullable().defaultTo(0);
    table.text('notas');
    table.boolean('is_own_brand'); // nullable; antes pertenece_mega_dulces
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'exhibitions_tenant_id_composite' });

    table.foreign(['tenant_id', 'visit_id'], 'fk_exhibitions_tenant_visit')
      .references(['tenant_id', 'id']).inTable('visits').onDelete('CASCADE');

    table.index('tenant_id', 'idx_exhibitions_tenant');
    table.index(['tenant_id', 'visit_id'], 'idx_exhibitions_tenant_visit');
    table.index(['tenant_id', 'is_own_brand'], 'idx_exhibitions_tenant_own_brand');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EXHIBITION_PHOTOS — fotos en Cloudinary
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('exhibition_photos', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('exhibition_id').notNullable();
    table.text('photo_url').notNullable();
    table.string('cloudinary_public_id', 255); // para deleteciones limpias
    table.integer('orden').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');

    table.foreign(['tenant_id', 'exhibition_id'], 'fk_exhibition_photos_tenant_exhibition')
      .references(['tenant_id', 'id']).inTable('exhibitions').onDelete('CASCADE');

    table.index('tenant_id', 'idx_exhibition_photos_tenant');
    table.index(['tenant_id', 'exhibition_id'], 'idx_exhibition_photos_tenant_exhibition');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS en las 5 tablas
  // ─────────────────────────────────────────────────────────────────────────
  for (const t of ['stores', 'daily_assignments', 'visits', 'exhibitions', 'exhibition_photos']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    `);
  }

  // Grants explícitos para app_runtime
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON stores, daily_assignments, visits, exhibitions, exhibition_photos TO app_runtime`);

  // Comments
  await knex.raw(`COMMENT ON COLUMN exhibitions.is_own_brand IS 'TRUE = exhibición de marca propia del tenant. FALSE = competencia. NULL = no aplica/sin clasificar. Reemplaza pertenece_mega_dulces del legacy.'`);
  await knex.raw(`COMMENT ON COLUMN visits.total_score IS 'Score agregado de todas las exhibitions de esta visita. Calculado por scoring-v2 service.'`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('exhibition_photos');
  await knex.schema.dropTableIfExists('exhibitions');
  await knex.schema.dropTableIfExists('visits');
  await knex.schema.dropTableIfExists('daily_assignments');
  await knex.schema.dropTableIfExists('stores');
};
