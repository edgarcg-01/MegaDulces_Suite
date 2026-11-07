'use strict';
/**
 * `[ALC.3.5]` — La solicitud de alta guarda **dónde está el cliente** (opcional).
 *
 * Francisco (2026-11-06): *«podemos agregar la info de geolocalización en base al domicilio
 * registrado»*, y *«sí, hazlo»* a la propuesta de dos botones: «Ubicar en el mapa» (el
 * geocodificador que ya usa Reparto, `GET /reports/geocode`) y «Usar mi ubicación» (el GPS del
 * teléfono del vendedor parado en la tienda).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-06) ──────────────────────────────────────────
 *  · `commercial.customers` ya tiene `latitude`/`longitude` (numeric): 628 de 1,903 clientes las
 *    traen. Al ligar la solicitud, las coordenadas pasan ahí si el cliente no tenía.
 *  · Kepler no recibe coordenadas: la Suite no escribe en Kepler (D1-a).
 *
 * Columnas NUEVAS y NULLABLE (la ubicación es opcional): ningún camino de inserción existente se
 * rompe (regla 14). Las dos coordenadas van juntas o ninguna; el origen dice de dónde salió el
 * punto, y la precisión (metros) sólo la da el GPS.
 *
 * Idempotente: `hasColumn` antes de agregar y el CHECK con `IF NOT EXISTS` por nombre.
 *
 * @param { import("knex").Knex } knex
 */
const TABLA = 'customer_onboarding_requests';
const CHECK = 'customer_onboarding_requests_location_chk';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const s = knex.schema.withSchema('commercial');
  const falta = async (c) => !(await s.hasColumn(TABLA, c));
  if (await falta('latitude')) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN latitude numeric(9,6)`);
  if (await falta('longitude')) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN longitude numeric(9,6)`);
  if (await falta('location_source')) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN location_source text`);
  if (await falta('location_accuracy_m')) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN location_accuracy_m numeric(10,1)`);
  const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ?`, [CHECK]);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${CHECK} CHECK (
        (latitude IS NULL AND longitude IS NULL AND location_source IS NULL AND location_accuracy_m IS NULL)
        OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
            AND location_source IN ('direccion', 'gps', 'mapa')
            AND (location_accuracy_m IS NULL OR location_accuracy_m >= 0))
      )`);
  }
  console.log(`  [alc_ubicacion_solicitud_alta] commercial.${TABLA}: latitude, longitude, location_source, location_accuracy_m + ${CHECK}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  for (const c of ['location_accuracy_m', 'location_source', 'longitude', 'latitude']) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN IF EXISTS ${c}`);
  }
};
