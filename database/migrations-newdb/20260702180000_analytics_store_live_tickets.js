/**
 * Proyecto "Tienda" (TDA) — tabla de tickets de venta EN VIVO por sucursal.
 * La alimenta el poller on-prem `live-tickets-poller.js` (lee kdm1/kdm2 de las
 * sucursales cada ~25s y empuja los nuevos vía `POST /store/live/ingest`), y el
 * `StoreService` la usa para el snapshot inicial + emite cada ticket por WebSocket
 * (namespace `/store`). Retención corta (se limpia > 3 días); NO es la fuente de
 * verdad de venta (eso es analytics.sales_daily) — es un buffer para el monitor live.
 *
 * Aditiva, idempotente, solo schema `analytics`.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('store_live_tickets')) return;
  await knex.raw(`
    CREATE TABLE analytics.store_live_tickets (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL,
      warehouse_code text NOT NULL,
      warehouse_name text,
      serie          text NOT NULL,
      folio          text NOT NULL,
      ticket_ts      timestamptz NOT NULL,
      total          numeric NOT NULL DEFAULT 0,
      forma_pago     text,
      items          jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_store_live_ticket ON analytics.store_live_tickets (tenant_id, warehouse_code, serie, folio)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_store_live_ts ON analytics.store_live_tickets (tenant_id, ticket_ts DESC)`);
  await knex.raw(`GRANT SELECT, INSERT ON analytics.store_live_tickets TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('store_live_tickets');
};
