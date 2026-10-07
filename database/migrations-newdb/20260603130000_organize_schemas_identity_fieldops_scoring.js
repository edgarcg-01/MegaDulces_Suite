/**
 * Sprint orden DB — 3 schemas nuevos con VIEWS passthrough para agrupar
 * lógicamente el contenido mezclado de `public.*`.
 *
 * Patrón idéntico al schema `catalog` (migración 20260603120000): VIEWS read-only
 * sobre tablas que viven en public. Cero cambio de código de app. Beneficio:
 * navegación mental clara en DBeaver/pgAdmin + base para futuro refactor real.
 *
 * Mapeo lógico:
 *   identity.*    → users, tenants, role_permissions
 *   field_ops.*   → stores, zones, daily_assignments, daily_captures, visits,
 *                   exhibitions, exhibition_photos
 *   scoring.*     → rubric_criteria, rubric_levels, scoring_config,
 *                   scoring_config_versions, scoring_weights,
 *                   valid_exhibition_combinations, catalogs
 *
 * `public` queda con knex_migrations + knex_migrations_lock + tablas reales
 * (que el código sigue consumiendo directamente).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ────────── identity ──────────
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS identity`);
  await knex.raw(`GRANT USAGE ON SCHEMA identity TO app_runtime`);
  await knex.raw(`COMMENT ON SCHEMA identity IS 'Dominio Identity/Auth: VIEWS sobre tablas en public. Tablas reales NO movidas. Usar public.users en código de app.'`);

  for (const [view, src, deletedFilter] of [
    ['users', 'public.users', true],
    ['tenants', 'public.tenants', true],
    ['role_permissions', 'public.role_permissions', false],
  ]) {
    await knex.raw(`DROP VIEW IF EXISTS identity.${view}`);
    const whereClause = deletedFilter ? ' WHERE deleted_at IS NULL' : '';
    await knex.raw(`CREATE VIEW identity.${view} AS SELECT * FROM ${src}${whereClause}`);
    await knex.raw(`GRANT SELECT ON identity.${view} TO app_runtime`);
  }

  // ────────── field_ops ──────────
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS field_ops`);
  await knex.raw(`GRANT USAGE ON SCHEMA field_ops TO app_runtime`);
  await knex.raw(`COMMENT ON SCHEMA field_ops IS 'Dominio Field Operations: auditoría visitas a PdV, exhibiciones, capturas. VIEWS sobre tablas en public.'`);

  for (const [view, src, deletedFilter] of [
    ['stores', 'public.stores', true],
    ['zones', 'public.zones', true],
    ['daily_assignments', 'public.daily_assignments', true],
    ['daily_captures', 'public.daily_captures', false],
    ['visits', 'public.visits', false],
    ['exhibitions', 'public.exhibitions', false],
    ['exhibition_photos', 'public.exhibition_photos', false],
  ]) {
    await knex.raw(`DROP VIEW IF EXISTS field_ops.${view}`);
    const whereClause = deletedFilter ? ' WHERE deleted_at IS NULL' : '';
    await knex.raw(`CREATE VIEW field_ops.${view} AS SELECT * FROM ${src}${whereClause}`);
    await knex.raw(`GRANT SELECT ON field_ops.${view} TO app_runtime`);
  }

  // ────────── scoring ──────────
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS scoring`);
  await knex.raw(`GRANT USAGE ON SCHEMA scoring TO app_runtime`);
  await knex.raw(`COMMENT ON SCHEMA scoring IS 'Dominio Scoring: rúbricas, pesos, config del sistema de evaluación. VIEWS sobre tablas en public.'`);

  for (const [view, src, deletedFilter] of [
    ['rubric_criteria', 'public.rubric_criteria', false],
    ['rubric_levels', 'public.rubric_levels', false],
    ['scoring_config', 'public.scoring_config', false],
    ['scoring_config_versions', 'public.scoring_config_versions', false],
    ['scoring_weights', 'public.scoring_weights', false],
    ['valid_exhibition_combinations', 'public.valid_exhibition_combinations', false],
    ['catalogs', 'public.catalogs', false],
  ]) {
    await knex.raw(`DROP VIEW IF EXISTS scoring.${view}`);
    const whereClause = deletedFilter ? ' WHERE deleted_at IS NULL' : '';
    await knex.raw(`CREATE VIEW scoring.${view} AS SELECT * FROM ${src}${whereClause}`);
    await knex.raw(`GRANT SELECT ON scoring.${view} TO app_runtime`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Drop VIEWS (no drop schemas — pueden estar siendo usados por reports)
  const drops = [
    'identity.users', 'identity.tenants', 'identity.role_permissions',
    'field_ops.stores', 'field_ops.zones', 'field_ops.daily_assignments',
    'field_ops.daily_captures', 'field_ops.visits', 'field_ops.exhibitions',
    'field_ops.exhibition_photos',
    'scoring.rubric_criteria', 'scoring.rubric_levels', 'scoring.scoring_config',
    'scoring.scoring_config_versions', 'scoring.scoring_weights',
    'scoring.valid_exhibition_combinations', 'scoring.catalogs',
  ];
  for (const v of drops) {
    await knex.raw(`DROP VIEW IF EXISTS ${v}`);
  }
};
