/**
 * SYNC.2.0 — schema `kepler_ods` = espejo CRUDO de Kepler en prod (CDC genérico).
 *
 * El pipe genérico (replicate-ods.js → feeds-ingest handler 'raw-upsert') replica
 * cualquier tabla `md.*` de Kepler (vía KP_CONCENTRADA) a `kepler_ods.<tabla>`, con
 * UPSERT sin churn por (sucursal, PK-origen). Las TABLAS las crea el handler en runtime
 * (auto-DDL, tabla-agnóstico) — esta migración solo prepara el schema + permisos + el
 * default privilege para que TODA tabla nueva quede legible por `app_runtime` sin tocar
 * la migración cada vez (ADR: auto-DDL confinado a `kepler_ods`, jamás toca commercial/analytics).
 *
 * kepler_ods es single-tenant (Kepler = Mega Dulces): sin tenant_id, sin RLS. La PK compuesta
 * (sucursal, cN…) garantiza unicidad entre sucursales.
 *
 * Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS kepler_ods`);

  // Marca de frescura por tabla (la mantiene el handler en cada push) → la lee /admin/db-health.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS kepler_ods._sync_status (
      table_name   text PRIMARY KEY,
      last_push_at timestamptz NOT NULL DEFAULT now(),
      rows_last    integer DEFAULT 0,
      rows_seen    integer DEFAULT 0
    )`);

  // Permisos a app_runtime (si el rol existe — en dev local puede no estar).
  const hasRole = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname='app_runtime'`)).rows.length;
  if (hasRole) {
    await knex.raw(`GRANT USAGE ON SCHEMA kepler_ods TO app_runtime`);
    await knex.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA kepler_ods TO app_runtime`);
    // Toda tabla futura creada por el owner del pipe queda legible sin re-migrar.
    await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA kepler_ods GRANT SELECT ON TABLES TO app_runtime`);
  }
};

exports.down = async function (knex) {
  // No se dropea el schema (contiene el espejo crudo). Solo la marca de status.
  await knex.raw(`DROP TABLE IF EXISTS kepler_ods._sync_status`);
};
