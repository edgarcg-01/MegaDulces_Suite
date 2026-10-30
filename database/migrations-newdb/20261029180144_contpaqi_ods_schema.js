'use strict';
/**
 * `[CP.9.2]` — Los schemas de la réplica cruda de ContPAQi: `contpaqi_ods` (contabilidad, generales, catálogos del SAT,
 * directorio y metadatos del ADD) y `contpaqi_nom` (nóminas). Mismo patrón que `kepler_ods` (ADR-046,
 * `20260811120000_kepler_ods_schema.js`): esta migración prepara schema, marca de estado y permisos; las TABLAS las
 * crea el replicador (`database/importers/contpaqi/replicate-contpaqi.js`) al vuelo, confinado a estos dos schemas.
 *
 * Single-tenant como `kepler_ods`: el origen es la contabilidad de una sola empresa; sin `tenant_id` ni RLS.
 * ⛔ `contpaqi_nom` NO se concede a `app_runtime` ni a `dev_ro`: son salarios y datos personales (Fase RH decide quién
 * los lee).
 *
 * ── Lo medido antes (sólo lectura, `[CP.9.0]`, 2026-10-29) ──────────────────────────────────
 *  · Contabilidad: 52 de 119 tablas con datos, 4,847,902 filas; las 52 con llave `Id` y `RowVersion`.
 *  · Nóminas: 59 de 76 tablas con datos, 5,731,321 filas. ADD principal: 13.5 M filas de metadatos.
 *
 * ⚠️ El replicador crea estos mismos objetos si no existen (la carga inicial se corrió el 2026-10-30 desde el pod
 *    `feeds-cron`, antes de que esta migración llegara a prod): aplicada después, no cambia nada. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const SCHEMAS = ['contpaqi_ods', 'contpaqi_nom'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const s of SCHEMAS) {
    await knex.raw(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await knex.raw(`
      CREATE TABLE IF NOT EXISTS ${s}._sync_status (
        table_name   text PRIMARY KEY,
        source_db    text,
        rows_source  bigint,
        rows_copied  bigint,
        last_push_at timestamptz NOT NULL DEFAULT now(),
        seconds      numeric,
        note         text
      )`);
  }
  await knex.raw(`REVOKE ALL ON SCHEMA contpaqi_nom FROM PUBLIC`);
  for (const rol of ['app_runtime', 'dev_ro']) {
    const existe = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = ?`, [rol])).rows.length;
    if (!existe) continue;
    await knex.raw(`GRANT USAGE ON SCHEMA contpaqi_ods TO ${rol}`);
    await knex.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA contpaqi_ods TO ${rol}`);
    await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA contpaqi_ods GRANT SELECT ON TABLES TO ${rol}`);
  }
};

/** No se borra la réplica (es dato): sólo la marca de estado y los permisos que dio el `up`. */
exports.down = async function down(knex) {
  for (const rol of ['app_runtime', 'dev_ro']) {
    const existe = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = ?`, [rol])).rows.length;
    if (!existe) continue;
    await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA contpaqi_ods REVOKE SELECT ON TABLES FROM ${rol}`);
    await knex.raw(`REVOKE USAGE ON SCHEMA contpaqi_ods FROM ${rol}`);
  }
  for (const s of SCHEMAS) await knex.raw(`DROP TABLE IF EXISTS ${s}._sync_status`);
};
