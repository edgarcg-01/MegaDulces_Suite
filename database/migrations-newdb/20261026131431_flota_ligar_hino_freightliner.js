'use strict';
/**
 * `[EMB.55]` — Liga los rastreadores del Hino 500 y del Freightliner estándar a SU unidad de Kepler,
 * y pone en la Suite la placa física del Hino. Pedido de Edgar (2026-10-26): «sí, lígalos pero
 * adecuadamente».
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-26) ────────────────────────────────────────
 *  · Los dos rastreadores existen desde el 17-sep y nunca se ligaron: «HINO 500-67BB9C» (6,697
 *    posiciones) y «FREIGHTLINER 882EW9» (5,898). Sus unidades de Kepler —00006 Hino, placa
 *    `69BB9C`, y 00005 Freightliner, placa `882-EW9`— tienen 53 y 42 guías en 2026 y ningún GPS.
 *  · Por qué no se ligaron solas: el sync comparaba la placa literal (`882EW9` ≠ `882-EW9`; el
 *    arreglo de fondo está en `matchVehicle`), y la del Hino es OTRA: el GPS y la hoja de costos de
 *    Transportes dicen 67-BB-9C; Kepler, 69BB9C.
 *  · ⭐ Que son la misma unidad se VERIFICÓ, no se supuso: día por día (17-sep → 26-oct), cuando la
 *    unidad de Kepler tiene guías a Morelia o a Zamora, ese GPS llega a Morelia (lat ≈ 19.70) o a
 *    Zamora (≈ 19.94) al día siguiente de la fecha de la guía, que es cuando sale el camión.
 *    Freightliner: guías del 20-oct a Morelia Madero → GPS en Morelia el 21; guías del 8-oct a
 *    Zamora → GPS en Zamora el 9. Hino: guías del 15-oct a Morelia → GPS en Morelia el 16; del
 *    12-oct a Zamora → GPS en Zamora el 13.
 *  · ⛔ La F-350 (Kepler 00007 `MZ0108` contra el GPS `MZ0108A`) NO se fusiona: la misma prueba la
 *    contradice. Kepler le carga 27 guías a 7 sucursales el 7-oct mientras ese GPS recorrió 7 km, y
 *    el 24-oct guías a Morelia con el GPS sin bajar de lat 20.33. En Kepler esa unidad se usa para
 *    guías de varios camiones.
 *  · El carta porte no se usa (0 documentos), así que la placa nueva no altera nada timbrado.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. Hino (Kepler 00006): placa de la Suite `69BB9C` → `67BB9C`, sólo si sigue como la dejó Kepler
 *     y ninguna otra unidad viva la tiene. La de Kepler se queda en `transporte_placas` y la
 *     diferencia queda a la vista (EMB.6). El importer de dimensiones NO pisa la placa de una unidad
 *     que ya tiene clave, así que no se revierte sola.
 *  2. Cada rastreador a su unidad, sólo si sigue sin ligar y la unidad sigue viva.
 * Su historia desde el 17-sep la arma el ciclo nocturno (`rellenarHuecos`, EMB.55).
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA a todo el equipo
 *    hasta que alguien la aplique a mano. Se aplica en prod ANTES de soltar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[flota_ligar_hino_freightliner]';
const M = '00000000-0000-0000-0000-00000000d01c';
const NOTA_PLACA = 'EMB.55: placa física 67BB9C (GPS y hoja de costos de Transportes); en Kepler es 69BB9C';
const LIGAS = [
  { imei: '207226125', kepler: '00006', etiqueta: 'Hino 500' },
  { imei: '207226303', kepler: '00005', etiqueta: 'Freightliner estándar' },
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const placa = await knex.raw(
    `UPDATE logistics.vehicles v
        SET plate = '67BB9C', updated_at = now(), notes = coalesce(v.notes || ' · ', '') || ?
      WHERE v.tenant_id = ?::uuid AND v.kepler_code = '00006' AND v.deleted_at IS NULL AND v.plate = '69BB9C'
        AND NOT EXISTS (SELECT 1 FROM logistics.vehicles o
                         WHERE o.tenant_id = v.tenant_id AND o.deleted_at IS NULL AND o.id <> v.id
                           AND regexp_replace(upper(o.plate), '[^A-Z0-9]', '', 'g') = '67BB9C')
      RETURNING v.id`,
    [NOTA_PLACA, M],
  );

  const ligados = [];
  for (const l of LIGAS) {
    const r = await knex.raw(
      `UPDATE logistics.trackers t SET vehicle_id = v.id, updated_at = now()
         FROM logistics.vehicles v
        WHERE t.tenant_id = ?::uuid AND t.imei = ? AND t.deleted_at IS NULL AND t.vehicle_id IS NULL
          AND v.tenant_id = t.tenant_id AND v.kepler_code = ? AND v.deleted_at IS NULL
       RETURNING t.id`,
      [M, l.imei, l.kepler],
    );
    if (r.rowCount) ligados.push(l.etiqueta);
  }
  console.log(`${TAG} placa del Hino: ${placa.rowCount ? '67BB9C' : 'sin cambio'} · rastreadores ligados: ${ligados.join(', ') || '(ninguno)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const l of LIGAS) {
    await knex.raw(
      `UPDATE logistics.trackers t SET vehicle_id = NULL, updated_at = now()
         FROM logistics.vehicles v
        WHERE t.tenant_id = ?::uuid AND t.imei = ? AND t.vehicle_id = v.id AND v.kepler_code = ?`,
      [M, l.imei, l.kepler],
    );
  }
  await knex.raw(
    `UPDATE logistics.vehicles
        SET plate = '69BB9C', updated_at = now(),
            notes = nullif(replace(replace(notes, ' · ' || ?, ''), ?, ''), '')
      WHERE tenant_id = ?::uuid AND kepler_code = '00006' AND deleted_at IS NULL AND plate = '67BB9C'
        AND notes LIKE '%' || ? || '%'`,
    [NOTA_PLACA, NOTA_PLACA, M, NOTA_PLACA],
  );
};
