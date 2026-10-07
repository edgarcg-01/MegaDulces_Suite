/**
 * LTV.7 — alertas de negocio: extiende logistics.fleet_alerts.kind con tipos que
 * entienden la operación (no solo técnicos). v1 agrega 'stopped_with_pending'
 * (unidad detenida con pedidos sin entregar). Reservados para siguientes reglas:
 * 'off_route_zone', 'late_dispatch', 'returned_incomplete'.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('fleet_alerts');
  if (!exists) return;
  await knex.raw(`ALTER TABLE logistics.fleet_alerts DROP CONSTRAINT IF EXISTS logistics_fleet_alerts_kind_valid`);
  await knex.raw(`ALTER TABLE logistics.fleet_alerts ADD CONSTRAINT logistics_fleet_alerts_kind_valid CHECK (kind IN ('offline','speed','stopped_with_pending','off_route_zone','late_dispatch','returned_incomplete'))`);
};

exports.down = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('fleet_alerts');
  if (!exists) return;
  await knex.raw(`ALTER TABLE logistics.fleet_alerts DROP CONSTRAINT IF EXISTS logistics_fleet_alerts_kind_valid`);
  await knex.raw(`ALTER TABLE logistics.fleet_alerts ADD CONSTRAINT logistics_fleet_alerts_kind_valid CHECK (kind IN ('offline','speed'))`);
};
