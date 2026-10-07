/**
 * Migración inicial de la nueva DB multi-tenant `postgres_platform`.
 *
 * Crea:
 *   1. Extensiones requeridas (pgcrypto para gen_random_uuid).
 *   2. Tabla `tenants` (global, sin tenant_id) — registro de organizaciones.
 *   3. Función helper `current_tenant_id()` que lee `app.tenant_id` del contexto
 *      de la sesión actual (lo setea el TenantContextInterceptor del NestJS API).
 *
 * Convenciones que siguen TODAS las migraciones de esta DB:
 *   - snake_case en tablas y columnas.
 *   - IDs UUID v4 (gen_random_uuid()).
 *   - `tenant_id` UUID NOT NULL en cada tabla excepto las globales (esta y sync).
 *   - Audit fields completos: created_at, created_by, updated_at, updated_by,
 *     deleted_at, deleted_by.
 *   - Índices en `tenant_id` y `(tenant_id) WHERE deleted_at IS NULL`.
 *   - RLS policy `tenant_isolation`.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // 1. Extensiones
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  // 2. Tabla tenants — GLOBAL, sin tenant_id (es la raíz de tenancy)
  await knex.schema.createTable('tenants', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('slug', 64).notNullable().unique();
    table.string('nombre', 200).notNullable();
    table.boolean('activo').notNullable().defaultTo(true);
    table.string('plan', 32).notNullable().defaultTo('standard'); // standard | enterprise | trial
    table.jsonb('metadata').notNullable().defaultTo('{}'); // espacio libre por tenant
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at');
    table.index('slug', 'idx_tenants_slug');
    table.index(['activo'], 'idx_tenants_activo', { predicate: knex.whereRaw('deleted_at IS NULL') });
  });

  // 3. Función helper para leer el tenant context de la sesión actual.
  // El NestJS API setea esto vía SET LOCAL app.tenant_id = '...' al inicio
  // de cada request, dentro de una transacción.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
    $$ LANGUAGE sql STABLE;
  `);

  // 4. Comentario explicativo a nivel DB para futuros mantenedores.
  await knex.raw(`
    COMMENT ON TABLE tenants IS
      'Registro de organizaciones (tenants). Tabla GLOBAL — no tiene tenant_id porque ES la raíz de tenancy. Cualquier query cross-tenant usa esta tabla. El slug es human-readable y único.';
  `);
  await knex.raw(`
    COMMENT ON FUNCTION current_tenant_id() IS
      'Devuelve el tenant_id seteado en la sesión actual vía SET LOCAL app.tenant_id. Usado por políticas RLS. Devuelve NULL si no hay contexto seteado (lo cual debe rechazarse en queries multi-tenant).';
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.raw('DROP FUNCTION IF EXISTS current_tenant_id()');
  await knex.schema.dropTableIfExists('tenants');
  // No droppeamos pgcrypto — puede ser usada por otras cosas.
};
