'use strict';
/**
 * `[CML.J]` D17 opción A — el MISMO viaje físico se paga UNA vez.
 *
 * Cuando a un camión lo mandan a otro destino estando en camino, a veces la sucursal hace OTRA guía
 * en Kepler. Las dos guías son un solo viaje, pero cada una pagaba comisión y viático: el viaje se
 * pagaba dos veces. El GPS lo SUGIERE (misma unidad, misma salida); el coordinador lo CONFIRMA y
 * aquí queda guardado. Con la confirmación, el reporte de Pagos de viaje paga a cada persona la
 * comisión de la ruta mayor y un solo viático (la carga, cajas × tarifa, sigue por guía).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-23, catorcena 5→18 nov) ────────────────────
 *  · 20 de las 118 guías con GPS comparten salida con otra: 8 viajes físicos.
 *  · 66 de 448 guías ya traen 2 o más destinos en la misma guía (eso ya se pagaba una vez).
 *
 * `same_trip_as` guarda la clave de Kepler (`SUC|GUIA`) de la otra guía, no su id: la otra puede no
 * tener hoja en la Suite todavía. Sólo columnas nulas: ningún camino que inserta cambia (regla 14).
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'delivery_guides';
const COLUMNAS = {
  same_trip_as: (t) => t.text('same_trip_as').nullable(),
  same_trip_by: (t) => t.uuid('same_trip_by').nullable(),
  same_trip_at: (t) => t.timestamp('same_trip_at', { useTz: true }).nullable(),
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const faltan = [];
  for (const c of Object.keys(COLUMNAS)) {
    if (!(await knex.schema.withSchema('logistics').hasColumn(TABLA, c))) faltan.push(c);
  }
  if (faltan.length) {
    await knex.schema.withSchema('logistics').alterTable(TABLA, (t) => { for (const c of faltan) COLUMNAS[c](t); });
  }
  await knex.raw(`COMMENT ON COLUMN logistics.delivery_guides.same_trip_as IS
    '[CML.J] Clave de Kepler (SUC|GUIA) de la otra guía del MISMO viaje físico, confirmado por el coordinador. Null = no confirmado.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const hay = [];
  for (const c of Object.keys(COLUMNAS)) {
    if (await knex.schema.withSchema('logistics').hasColumn(TABLA, c)) hay.push(c);
  }
  if (hay.length) await knex.schema.withSchema('logistics').alterTable(TABLA, (t) => { for (const c of hay) t.dropColumn(c); });
};
