/**
 * SM.7 — Catálogo de cajeros POS (nombres) para el Supervisor de Movimientos.
 *
 * Resuelve el código de cajero (`40VMC`, `54TYSL`, `02`…) que sale en los cortes
 * a un nombre legible. Lo alimenta el importer on-prem `import-pos-cashiers.js`,
 * que une `md.kdpv_gerentes` (códigos prefijados por sucursal, c1=suc/c2=clave/c3=nombre)
 * y `md.kdpv_kdku` (códigos cortos, c1=clave/c2=nombre) de las 6 sucursales.
 *
 * Escopeado por (tenant_id, warehouse_code, cajero_code) — el mismo código corto
 * ('02') tiene distinto dueño por sucursal, por eso NO es global.
 * analytics.* sin RLS → filtro tenant_id explícito. Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('pos_cashiers')) return;
  await knex.raw(`
    CREATE TABLE analytics.pos_cashiers (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL,
      warehouse_code text NOT NULL,       -- sucursal ('01','02'…)
      cajero_code    text NOT NULL,       -- código tal cual aparece en cash_cuts.cajero_cierre
      nombre         text NOT NULL,
      source         text NOT NULL DEFAULT 'kepler',  -- 'gerente' | 'cajero'
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_cashier ON analytics.pos_cashiers (tenant_id, warehouse_code, cajero_code)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.pos_cashiers TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('pos_cashiers');
};
