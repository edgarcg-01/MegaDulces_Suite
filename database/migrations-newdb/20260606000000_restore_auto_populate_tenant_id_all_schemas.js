/**
 * Migración — Restaurar el trigger `trg_auto_populate_tenant_id` en TODAS las
 * tablas multi-tenant, en su schema ACTUAL.
 *
 * Contexto:
 * El trigger original (20260527180000) se creó sobre `public.*`. Los sprints de
 * organización de schemas (identity/catalog/field_ops/scoring/trade) movieron
 * las tablas con `ALTER TABLE ... SET SCHEMA`. En local el trigger sobrevivió al
 * move, pero en PROD quedó ausente sobre `identity.users`, `identity.role_permissions`
 * y `catalog`/`trade.catalogs` — los INSERT legacy fallaban con `23502 NOT NULL`
 * en tenant_id (incidentes 2026-06-05: alta de usuarios / roles / rutas).
 *
 * Esta migración (re)crea el trigger en cada TABLA REAL (`relkind='r'`) que tenga
 * `tenant_id NOT NULL`, resolviendo su schema dinámicamente. Así no depende del
 * historial de moves y queda cubierto todo el dominio, incluso tablas futuras.
 *
 * Seguridad:
 *   - Solo tablas ordinarias (`relkind='r'`): excluye las VISTAS passthrough de
 *     `public.*` (Postgres rechaza triggers BEFORE INSERT en vistas), las MVs de
 *     `analytics.*` y las foreign tables del FDW (NO se consulta data del FDW,
 *     solo el catálogo local — no reproduce el crash de boot por FDW).
 *   - Solo `tenant_id NOT NULL`: las tablas que permiten tenant_id nullable
 *     (filas globales/sistema) quedan fuera a propósito.
 *   - El trigger es no-op cuando el INSERT ya trae tenant_id (commercial/logistics
 *     lo setean vía current_tenant_id()); solo actúa cuando viene NULL.
 *
 * Idempotente: DROP TRIGGER IF EXISTS + CREATE en cada tabla; CREATE OR REPLACE
 * de la función.
 *
 * @param { import("knex").Knex } knex
 */

const DISCOVER_TABLES = `
  SELECT n.nspname AS schema, c.relname AS tbl
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
    AND a.attname = 'tenant_id'
    AND a.attnotnull = true
    AND NOT a.attisdropped
  WHERE c.relkind = 'r'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY n.nspname, c.relname
`;

exports.up = async function (knex) {
  // 1. Asegurar que la función exista (puede faltar en prod).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.auto_populate_tenant_id()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.tenant_id IS NULL THEN
        NEW.tenant_id := public.current_tenant_id();
        IF NEW.tenant_id IS NULL THEN
          RAISE EXCEPTION
            'tenant_id no provisto y current_tenant_id() no seteado en contexto. '
            'Verificar Bearer JWT con tenant_id + TenantContextInterceptor.'
            USING ERRCODE = '23502', COLUMN = 'tenant_id';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // 2. (Re)crear el trigger en cada tabla real con tenant_id NOT NULL.
  const { rows } = await knex.raw(DISCOVER_TABLES);
  for (const { schema, tbl } of rows) {
    await knex.raw(`
      DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON "${schema}"."${tbl}";
      CREATE TRIGGER trg_auto_populate_tenant_id
        BEFORE INSERT ON "${schema}"."${tbl}"
        FOR EACH ROW
        EXECUTE FUNCTION public.auto_populate_tenant_id();
    `);
  }
  console.log(
    `  ✓ trg_auto_populate_tenant_id (re)creado en ${rows.length} tablas multi-tenant`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const { rows } = await knex.raw(DISCOVER_TABLES);
  for (const { schema, tbl } of rows) {
    await knex.raw(
      `DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON "${schema}"."${tbl}"`,
    );
  }
  // La función NO se borra: la administra la migración 20260527180000.
};
