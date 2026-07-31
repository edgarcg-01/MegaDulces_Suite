/**
 * SM.10 — Sesiones de caja ABIERTAS (Tienda live).
 *
 * El sistema de arqueo/SM solo veía cortes CERRADOS (`analytics.cash_cuts`). Esta
 * tabla trae la otra mitad: qué caja está ABIERTA ahora y quién la abrió. La
 * alimenta `import-cash-sessions.js` leyendo `md.kdpv_folio_caja` con
 * `c10='1800-01-01'` (fecha de cierre centinela = abierta). Cruzada con los tickets
 * en vivo por cajero (`store_live_tickets.cajero`) responde "quién está cobrando".
 *
 * Además: `+ cajero` en `store_live_tickets` — el ticket de Kepler trae el cajero
 * en `kdm1.c67`, así el monitor pasa de "la sucursal vende" a "la cajera X cobra".
 *
 * analytics.* sin RLS → tenant explícito. Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // 1. cajero en los tickets en vivo (para ligar actividad a la cajera).
  if (await knex.schema.withSchema('analytics').hasTable('store_live_tickets')) {
    if (!(await knex.schema.withSchema('analytics').hasColumn('store_live_tickets', 'cajero'))) {
      await knex.raw(`ALTER TABLE analytics.store_live_tickets ADD COLUMN cajero text`);
      await knex.raw(`CREATE INDEX IF NOT EXISTS ix_store_live_cajero ON analytics.store_live_tickets (tenant_id, cajero, ticket_ts DESC)`);
    }
  }

  // 2. sesiones de caja (abiertas/cerradas).
  if (!(await knex.schema.withSchema('analytics').hasTable('cash_sessions'))) {
    await knex.raw(`
      CREATE TABLE analytics.cash_sessions (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        warehouse_code text NOT NULL,          -- sucursal (kdpv c1)
        warehouse_name text,
        caja           text NOT NULL,          -- caja física (kdpv c2)
        folio          text NOT NULL,          -- folio del corte/sesión (kdpv c3)
        cajero_code    text,                   -- quien abrió (c7) o cerró (c8)
        cajero_nombre  text,                   -- denormalizado de pos_cashiers
        business_date  date NOT NULL,          -- fecha de apertura
        opened_at      timestamptz,            -- c5 + c6
        closed_at      timestamptz,            -- NULL = ABIERTA (cobrando)
        status         text NOT NULL DEFAULT 'open',  -- open | closed
        source         text NOT NULL DEFAULT 'kepler',
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_session ON analytics.cash_sessions (tenant_id, warehouse_code, caja, folio)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cash_session_open ON analytics.cash_sessions (tenant_id, status, opened_at DESC)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.cash_sessions TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('cash_sessions');
  if (await knex.schema.withSchema('analytics').hasColumn('store_live_tickets', 'cajero')) {
    await knex.raw(`ALTER TABLE analytics.store_live_tickets DROP COLUMN cajero`);
  }
};
