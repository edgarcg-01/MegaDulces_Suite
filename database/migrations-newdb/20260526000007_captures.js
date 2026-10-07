/**
 * Migración: daily_captures (la última tabla del schema multi-tenant).
 *
 * Esta tabla es el CORE del negocio actual — registra capturas diarias de
 * visitas con todas sus exhibiciones (en JSONB), GPS, scoring computado, etc.
 *
 * Cambios vs legacy (aprovechando reset):
 *   - QUITAMOS `captured_by_username` (audit 1.7 — string redundante con user_id FK).
 *   - QUITAMOS `zona_captura` (audit 1.12 — zona se obtiene del store o user).
 *   - `store_id` ahora con composite FK cross-tenant safe.
 *   - `config_version_id` ahora con composite FK cross-tenant safe.
 *
 * Notable: NO migramos la tabla legacy `captures` (deprecated, no usada por
 * frontend — solo el endpoint /api/captures sigue ahí huérfano).
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('daily_captures', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');

    // Identificación
    table.string('folio', 50).notNullable(); // Ej. "U-31-153045"
    table.uuid('user_id').notNullable();
    table.uuid('store_id'); // nullable porque legacy permitía capturas sin store

    // Temporalidad
    table.date('fecha').notNullable();
    table.timestamp('hora_inicio').notNullable();
    table.timestamp('hora_fin').notNullable();

    // Datos de la visita (JSONB para flexibilidad)
    table.jsonb('exhibiciones').notNullable().defaultTo('[]'); // Array de exhibiciones evaluadas
    table.jsonb('stats').defaultTo('{}'); // Estadísticas agregadas

    // GPS
    table.decimal('latitud', 10, 8);
    table.decimal('longitud', 11, 8);

    // Scoring (calculado al momento — inmutable después)
    table.uuid('config_version_id'); // versión de scoring vigente al momento
    table.decimal('score_maximo', 10, 2);
    table.decimal('score_calidad_pct', 5, 2);
    table.decimal('score_cobertura_pct', 5, 2);
    table.decimal('score_final_pct', 5, 2);

    // Audit fields
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'folio'], { indexName: 'daily_captures_tenant_folio_unique' });

    // FKs composite cross-tenant safe
    table.foreign(['tenant_id', 'user_id'], 'fk_daily_captures_tenant_user')
      .references(['tenant_id', 'id']).inTable('users').onDelete('RESTRICT');
    table.foreign(['tenant_id', 'store_id'], 'fk_daily_captures_tenant_store')
      .references(['tenant_id', 'id']).inTable('stores').onDelete('SET NULL');
    table.foreign(['tenant_id', 'config_version_id'], 'fk_daily_captures_tenant_config_version')
      .references(['tenant_id', 'id']).inTable('scoring_config_versions').onDelete('SET NULL');

    // Índices para queries frecuentes en reports
    table.index('tenant_id', 'idx_daily_captures_tenant');
    table.index(['tenant_id', 'user_id', 'fecha'], 'idx_daily_captures_tenant_user_fecha');
    table.index(['tenant_id', 'fecha'], 'idx_daily_captures_tenant_fecha');
    table.index(['tenant_id', 'store_id'], 'idx_daily_captures_tenant_store');
    table.index(['tenant_id', 'folio'], 'idx_daily_captures_tenant_folio');
  });

  // RLS
  await knex.raw(`ALTER TABLE daily_captures ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE daily_captures FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON daily_captures
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())
  `);

  // Grants
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON daily_captures TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE daily_captures IS 'Capturas diarias de visitas (core del negocio). exhibiciones JSONB contiene array de exhibiciones evaluadas con sus fotos.'`);
  await knex.raw(`COMMENT ON COLUMN daily_captures.exhibiciones IS 'Array JSONB. Cada elemento es una exhibición con campos: posicion, tipo, nivel_ejecucion, score, fotoUrl, notas, productos[]'`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('daily_captures');
};
