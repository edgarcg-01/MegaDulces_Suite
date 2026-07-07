/**
 * SM.1 — tabla de cortes/arqueos de caja POS por sucursal (Supervisor de Movimientos).
 * La alimenta el importer on-prem `import-cash-cuts.js` (lee md.kdpv_folio_caja de
 * las 6 sucursales Kepler y UPSERT). Es la fuente del **Plano 2 (caja)**: el detector
 * marca `|efectivo_diff| ≥ umbral` y faltantes recurrentes por cajero → reconciliation.discrepancies.
 *
 * analytics.* = sin RLS (Postgres no soporta RLS en MVs/analítica cross-tenant);
 * filtro tenant_id EXPLÍCITO en cada query. Aditiva, idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('cash_cuts')) return;
  await knex.raw(`
    CREATE TABLE analytics.cash_cuts (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          uuid NOT NULL,
      warehouse_code     text NOT NULL,         -- sucursal (kdpv_folio_caja.c1: '01','02'…)
      warehouse_name     text,
      caja               text NOT NULL,         -- c2 nº caja
      folio              text NOT NULL,         -- c3 folio del corte
      business_date      date NOT NULL,         -- c5 fecha apertura
      opened_at          timestamptz,
      closed_at          timestamptz,
      cajero_apertura    text,                  -- c7
      cajero_cierre      text,                  -- c8
      turno              text,                  -- c13
      efectivo_esperado  numeric NOT NULL DEFAULT 0,  -- c15
      efectivo_contado   numeric NOT NULL DEFAULT 0,  -- c25 (arqueo)
      efectivo_diff      numeric NOT NULL DEFAULT 0,  -- c35 (= esperado − contado; + faltante / − sobrante)
      tarjeta_esperado   numeric NOT NULL DEFAULT 0,  -- c16
      tarjeta_contado    numeric NOT NULL DEFAULT 0,  -- c26
      transfer_esperado  numeric NOT NULL DEFAULT 0,  -- c17
      transfer_contado   numeric NOT NULL DEFAULT 0,  -- c27
      total_venta        numeric NOT NULL DEFAULT 0,  -- c49
      cerrado            boolean NOT NULL DEFAULT true,
      source             text NOT NULL DEFAULT 'kepler',
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_cut ON analytics.cash_cuts (tenant_id, warehouse_code, caja, business_date, folio)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cash_cut_date ON analytics.cash_cuts (tenant_id, business_date DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cash_cut_diff ON analytics.cash_cuts (tenant_id, warehouse_code, cajero_cierre)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.cash_cuts TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('cash_cuts');
};
