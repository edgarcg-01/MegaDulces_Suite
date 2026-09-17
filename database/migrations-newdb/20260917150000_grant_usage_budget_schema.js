'use strict';
/**
 * FIX-FORWARD — `GRANT USAGE ON SCHEMA budget TO app_runtime`.
 *
 * `20260914130000_budget_and_obligation_origins.js` creó el schema `budget` y otorgó permisos
 * de TABLA (`GRANT SELECT,INSERT,UPDATE,DELETE ON <table>`) pero **olvidó el USAGE del schema**.
 * Sin USAGE, los grants de tabla son inútiles: Postgres deniega el schema primero.
 *
 * Síntoma medido en prod (2026-09-17): `/api/finance/payment-calendar/obligations` y
 * `/days/:d/summary` tiraban 500 con `permission denied for schema budget` (42501) — el runtime
 * (app_runtime, que el API hereda) no podía ni USAR el schema. `finance` y `commercial` sí
 * funcionaban porque son schemas viejos que ya traían el USAGE.
 *
 * Ya se aplicó el grant a mano a prod como hotfix; esta migración lo deja reproducible para
 * platform_test, CI y cualquier rebuild. Idempotente: `GRANT` repetido es no-op.
 * `ALTER DEFAULT PRIVILEGES` cubre las tablas futuras del schema (p.ej. budget_lines_ledger).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const has = (await knex.raw(`SELECT to_regnamespace('budget') IS NOT NULL AS ok`)).rows[0].ok;
  if (!has) return; // el schema no existe en este entorno → nada que otorgar
  await knex.raw(`GRANT USAGE ON SCHEMA budget TO app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA budget TO app_runtime`);
  await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA budget GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime`);
  console.log('  ✓ USAGE + privilegios de tabla de schema budget otorgados a app_runtime.');
};

exports.down = async function down(knex) {
  const has = (await knex.raw(`SELECT to_regnamespace('budget') IS NOT NULL AS ok`)).rows[0].ok;
  if (!has) return;
  await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA budget REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_runtime`);
  await knex.raw(`REVOKE USAGE ON SCHEMA budget FROM app_runtime`);
};
