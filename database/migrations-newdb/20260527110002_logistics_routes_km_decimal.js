/**
 * Migración J.8.2.0 — Cambiar logistics.routes.estimated_km de integer a numeric(10,2).
 *
 * Razón: los datos reales del repo origen tienen km con decimal (126.7, 165.4, etc).
 * En la migración original se eligió integer asumiendo redondeo. La importación
 * real necesita precisión decimal.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw('ALTER TABLE logistics.routes ALTER COLUMN estimated_km TYPE numeric(10,2)');
};

exports.down = async function (knex) {
  await knex.raw('ALTER TABLE logistics.routes ALTER COLUMN estimated_km TYPE integer USING ROUND(estimated_km)::integer');
};
