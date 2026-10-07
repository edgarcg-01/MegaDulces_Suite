/**
 * J12.3 — logistics.guide_recipients.sequence_order.
 *
 * Orden óptimo de visita del destinatario dentro del reparto (1..N), calculado
 * por el solver de ruta (nearest-neighbor + 2-opt) sobre las coordenadas del
 * cliente. NULL = sin optimizar aún.
 *
 * Idempotente. RLS heredada de la tabla.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('logistics').hasColumn('guide_recipients', 'sequence_order');
  if (!has) {
    await knex.raw(`ALTER TABLE logistics.guide_recipients ADD COLUMN sequence_order INTEGER`);
  }
  // Coords del almacén = origen del solver de ruta (CEDIS).
  if (!(await knex.schema.withSchema('commercial').hasColumn('warehouses', 'latitude'))) {
    await knex.raw(`ALTER TABLE commercial.warehouses ADD COLUMN latitude NUMERIC(10,7)`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('warehouses', 'longitude'))) {
    await knex.raw(`ALTER TABLE commercial.warehouses ADD COLUMN longitude NUMERIC(10,7)`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.warehouses DROP COLUMN IF EXISTS longitude`);
  await knex.raw(`ALTER TABLE commercial.warehouses DROP COLUMN IF EXISTS latitude`);
  await knex.raw(`ALTER TABLE logistics.guide_recipients DROP COLUMN IF EXISTS sequence_order`);
};
