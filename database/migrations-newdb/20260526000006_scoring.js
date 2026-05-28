/**
 * Migración: dominio de scoring.
 *
 * Tablas creadas:
 *   1. scoring_config              — config single-row legacy (JSONB)
 *   2. scoring_config_versions     — versiones del config (v1.0, v2.0...)
 *   3. scoring_weights             — pesos normalizados por versión (era scoring_pesos)
 *   4. rubric_criteria             — criterios de evaluación (era rubrica_criterios)
 *   5. rubric_levels               — niveles + multiplicadores (era rubrica_niveles)
 *   6. valid_exhibition_combinations — combinaciones posición×exhibición permitidas
 *
 * Cambios vs legacy:
 *   - Renombres: scoring_pesos → scoring_weights, rubrica_* → rubric_*,
 *     combinaciones_validas → valid_exhibition_combinations.
 *   - `creado_por` (string legacy) reemplazado por `created_by` FK estándar.
 *   - Agregamos `stores.exhibiciones_esperadas` (alter table existing).
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // SCORING_CONFIG — config single-row legacy (JSONB) usada por scoring v1
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('scoring_config', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.jsonb('config').notNullable().defaultTo(
      JSON.stringify({
        pesos_posicion: { caja: 100, adyacente: 70, vitrina: 60, exhibidor: 50, refrigerador: 40, anaquel: 25, detras: 10 },
        factores_tipo: { exhibidor: 2.0, refrigerador: 1.8, vitrina: 1.5, tira: 1.0 },
        niveles_ejecucion: { alto: 1.0, medio: 0.7, bajo: 0.4 },
      })
    );
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id'], { indexName: 'scoring_config_one_per_tenant' });
    table.index('tenant_id', 'idx_scoring_config_tenant');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCORING_CONFIG_VERSIONS — versiones de configuración (v1.0, v2.0...)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('scoring_config_versions', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.string('version', 20).notNullable();
    table.timestamp('fecha_inicio').notNullable().defaultTo(knex.fn.now());
    table.timestamp('fecha_fin'); // null = vigente
    table.text('notas');
    table.decimal('score_maximo', 10, 2);
    table.timestamp('score_maximo_calculado_at');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'version'], { indexName: 'scoring_config_versions_tenant_version_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'scoring_config_versions_tenant_id_composite' });
    table.index('tenant_id', 'idx_scoring_config_versions_tenant');
    table.index(['tenant_id', 'fecha_inicio', 'fecha_fin'], 'idx_scoring_config_versions_vigente');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCORING_WEIGHTS (legacy scoring_pesos) — pesos normalizados por versión
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('scoring_weights', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('config_version_id').notNullable();
    // Enum como CHECK constraint (Postgres) — más flexible que ENUM nativo (alter es doloroso)
    table.string('tipo', 20).notNullable();
    table.string('nombre', 100).notNullable();
    table.decimal('valor', 10, 2).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'config_version_id', 'tipo', 'nombre'], { indexName: 'scoring_weights_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'scoring_weights_tenant_id_composite' });

    table.foreign(['tenant_id', 'config_version_id'], 'fk_scoring_weights_tenant_version')
      .references(['tenant_id', 'id']).inTable('scoring_config_versions').onDelete('CASCADE');

    table.check("?? IN ('posicion', 'exhibicion', 'ejecucion')", ['tipo'], 'scoring_weights_tipo_check');

    table.index('tenant_id', 'idx_scoring_weights_tenant');
    table.index(['tenant_id', 'config_version_id', 'tipo'], 'idx_scoring_weights_version_tipo');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RUBRIC_CRITERIA (legacy rubrica_criterios) — criterios de evaluación
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('rubric_criteria', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('config_version_id').notNullable();
    table.string('criterio', 200).notNullable();
    table.string('descripcion', 500);
    table.integer('orden').notNullable().defaultTo(0);
    table.boolean('activo').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');

    table.foreign(['tenant_id', 'config_version_id'], 'fk_rubric_criteria_tenant_version')
      .references(['tenant_id', 'id']).inTable('scoring_config_versions').onDelete('CASCADE');

    table.index('tenant_id', 'idx_rubric_criteria_tenant');
    table.index(['tenant_id', 'config_version_id', 'activo'], 'idx_rubric_criteria_version_activo');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RUBRIC_LEVELS (legacy rubrica_niveles) — niveles ejecutivos (Alto/Medio/Bajo/Crítico)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('rubric_levels', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('config_version_id').notNullable();
    table.string('nombre', 50).notNullable(); // Alto, Medio, Bajo, Crítico
    table.integer('criterios_minimos').notNullable();
    table.integer('criterios_maximos').notNullable();
    table.decimal('multiplicador', 10, 2).notNullable();
    table.string('color', 20);
    table.integer('orden').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'config_version_id', 'nombre'], { indexName: 'rubric_levels_unique' });

    table.foreign(['tenant_id', 'config_version_id'], 'fk_rubric_levels_tenant_version')
      .references(['tenant_id', 'id']).inTable('scoring_config_versions').onDelete('CASCADE');

    table.index('tenant_id', 'idx_rubric_levels_tenant');
    table.index(['tenant_id', 'config_version_id'], 'idx_rubric_levels_version');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VALID_EXHIBITION_COMBINATIONS (legacy combinaciones_validas)
  // posicion_id y exhibicion_id apuntan a catalogs (catalog_id='ubicaciones' y 'conceptos')
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('valid_exhibition_combinations', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('config_version_id').notNullable();
    table.uuid('posicion_id').notNullable(); // catalogs (catalog_id='ubicaciones')
    table.uuid('exhibicion_id').notNullable(); // catalogs (catalog_id='conceptos')
    table.boolean('activo').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'config_version_id', 'posicion_id', 'exhibicion_id'], { indexName: 'valid_combos_unique' });

    table.foreign(['tenant_id', 'config_version_id'], 'fk_valid_combos_tenant_version')
      .references(['tenant_id', 'id']).inTable('scoring_config_versions').onDelete('CASCADE');
    table.foreign(['tenant_id', 'posicion_id'], 'fk_valid_combos_tenant_posicion')
      .references(['tenant_id', 'id']).inTable('catalogs').onDelete('RESTRICT');
    table.foreign(['tenant_id', 'exhibicion_id'], 'fk_valid_combos_tenant_exhibicion')
      .references(['tenant_id', 'id']).inTable('catalogs').onDelete('RESTRICT');

    table.index('tenant_id', 'idx_valid_combos_tenant');
    table.index(['tenant_id', 'config_version_id'], 'idx_valid_combos_version');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ALTER stores: agregar exhibiciones_esperadas (de migración legacy 20260414210000)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.alterTable('stores', (table) => {
    table.integer('exhibiciones_esperadas').defaultTo(5);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS en las 6 tablas nuevas
  // ─────────────────────────────────────────────────────────────────────────
  const tables = [
    'scoring_config',
    'scoring_config_versions',
    'scoring_weights',
    'rubric_criteria',
    'rubric_levels',
    'valid_exhibition_combinations',
  ];
  for (const t of tables) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    `);
  }

  // Grants explícitos para app_runtime
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(', ')} TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE scoring_config IS 'Config single-row legacy del scoring v1 (JSONB). Coexiste con scoring_config_versions. Un solo registro por tenant.'`);
  await knex.raw(`COMMENT ON TABLE scoring_config_versions IS 'Versiones del config (v1.0, v2.0...). fecha_fin=null indica versión vigente.'`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('stores', (table) => {
    table.dropColumn('exhibiciones_esperadas');
  });
  await knex.schema.dropTableIfExists('valid_exhibition_combinations');
  await knex.schema.dropTableIfExists('rubric_levels');
  await knex.schema.dropTableIfExists('rubric_criteria');
  await knex.schema.dropTableIfExists('scoring_weights');
  await knex.schema.dropTableIfExists('scoring_config_versions');
  await knex.schema.dropTableIfExists('scoring_config');
};
