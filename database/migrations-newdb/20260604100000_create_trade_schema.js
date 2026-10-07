/**
 * Fase L.1 — Crear schema `trade` (vacío).
 *
 * Sigue el patrón de las migraciones identity/catalog/logistics: schema
 * dedicado por dominio. `trade` agrupará las 14 tablas de trade marketing
 * actualmente en `public.*` (stores, zones, daily_captures, scoring_*, etc.).
 *
 * La migración L.2 (siguiente) mueve las tablas físicamente.
 *
 * ADR-015 — Schema reorg.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS trade`);
  await knex.raw(`GRANT USAGE ON SCHEMA trade TO app_runtime`);
  await knex.raw(
    `COMMENT ON SCHEMA trade IS 'Trade marketing: planograma + auditoría PdV. Multi-tenant via tenant_id + RLS forzada. Tablas movidas desde public.* en migración 20260604110000.'`,
  );
  console.log('  ✓ schema trade creado');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Solo dropear si está vacío. Si L.2 ya corrió, el down de L.2 mueve las
  // tablas de vuelta a public primero.
  await knex.raw(`DROP SCHEMA IF EXISTS trade RESTRICT`);
};
