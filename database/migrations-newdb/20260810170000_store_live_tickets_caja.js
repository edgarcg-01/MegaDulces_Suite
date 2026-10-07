/**
 * SM.10 fix — `caja` en los tickets en vivo.
 *
 * `/tienda/cajas` cruzaba la actividad por (sucursal, cajero), pero en Kepler UN
 * supervisor abre TODAS las cajas (kdpv c7) → su total salía duplicado en cada caja.
 * La atribución correcta es POR CAJA: el ticket de Kepler trae la caja en kdm1.c5
 * (y Wincaja en maestro.caja). Esta columna permite agrupar tickets por caja física.
 *
 * Aditiva + idempotente. analytics.* sin RLS.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('store_live_tickets'))) return;
  if (!(await knex.schema.withSchema('analytics').hasColumn('store_live_tickets', 'caja'))) {
    await knex.raw(`ALTER TABLE analytics.store_live_tickets ADD COLUMN caja text`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_store_live_caja ON analytics.store_live_tickets (tenant_id, warehouse_code, caja, ticket_ts DESC)`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('analytics').hasColumn('store_live_tickets', 'caja')) {
    await knex.raw(`ALTER TABLE analytics.store_live_tickets DROP COLUMN caja`);
  }
};
