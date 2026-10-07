/**
 * Fase CXC.12 (ADR-048) — Snapshot diario de cartera para TENDENCIA.
 *
 * `analytics.customer_receivables` es "hoy". Este snapshot guarda el agregado por día
 * (tenant × sucursal) para que DSO / vencido / aging tengan histórico real y se pueda
 * detectar "saldo creciente". Lo puebla el scanner (@Cron diario) + `/snapshot-now`.
 * analytics.* → sin RLS + GRANT SELECT app_runtime.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('customer_receivable_snapshots'))) {
    await knex.raw(`
      CREATE TABLE analytics.customer_receivable_snapshots (
        tenant_id      uuid NOT NULL,
        snapshot_date  date NOT NULL,
        sucursal       text NOT NULL,
        saldo_total    numeric NOT NULL DEFAULT 0,
        vencido_total  numeric NOT NULL DEFAULT 0,
        n_clientes     integer NOT NULL DEFAULT 0,
        por_vencer     numeric NOT NULL DEFAULT 0,
        d0_30          numeric NOT NULL DEFAULT 0,
        d31_60         numeric NOT NULL DEFAULT 0,
        d61_90         numeric NOT NULL DEFAULT 0,
        d90_plus       numeric NOT NULL DEFAULT 0,
        computed_at    timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, snapshot_date, sucursal)
      )`);
    await knex.raw(`CREATE INDEX ix_cxc_snap ON analytics.customer_receivable_snapshots (tenant_id, sucursal, snapshot_date)`);
    await knex.raw(`GRANT SELECT ON analytics.customer_receivable_snapshots TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.customer_receivable_snapshots`);
};
