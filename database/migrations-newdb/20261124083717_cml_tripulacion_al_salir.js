'use strict';
/**
 * `[CML.HV]` — La tripulación se guarda AL SALIR; el horario, al regresar.
 *
 * Hasta hoy la guía de un viaje de Kepler se completaba UNA vez, con la tripulación y el horario
 * juntos (`logistics-guides.service.ts` `complete()`): al salir el coordinador ya sabe quién va,
 * pero no podía guardarlo hasta que el camión regresaba. Ahora se guarda al despachar
 * (`POST /logistics/guides/:id/tripulacion`), sin calcular nada, y se puede corregir hasta que se
 * capture el horario. Estas dos columnas dicen CUÁNDO y QUIÉN la guardó:
 *  · distinguen «salió sin ayudantes» (guardado, sin ayudantes) de «nadie la ha capturado»
 *    (null) — sin ellas, la tripulación sugerida (`[CML.T1]`) volvería a llenar ayudantes;
 *  · dejan rastro de quién la cambió si un ayudante se baja a medio camino.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-20 y 2026-11-23) ──────────────────────────
 *  · La captura de la tripulación se usó en 4 de 448 viajes (catorcena 5→18 nov).
 *  · Sólo 118 de 448 guías tienen horario del GPS: en el resto, el horario llega al regreso.
 *
 * Sólo agrega columnas nulas: ningún camino que inserta en `delivery_guides` cambia (regla 14).
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'delivery_guides';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const s = knex.schema.withSchema('logistics');
  const faltaEn = !(await s.hasColumn(TABLA, 'crew_saved_at'));
  const faltaPor = !(await knex.schema.withSchema('logistics').hasColumn(TABLA, 'crew_saved_by'));
  if (faltaEn || faltaPor) {
    await knex.schema.withSchema('logistics').alterTable(TABLA, (t) => {
      if (faltaEn) t.timestamp('crew_saved_at', { useTz: true }).nullable();
      if (faltaPor) t.uuid('crew_saved_by').nullable();
    });
  }
  await knex.raw(`COMMENT ON COLUMN logistics.delivery_guides.crew_saved_at IS
    '[CML.HV] Cuándo se guardó la tripulación sin horario (al salir). Null = nadie la guardó por ese camino.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.delivery_guides.crew_saved_by IS
    '[CML.HV] Quién guardó (o corrigió por última vez) la tripulación antes del horario.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const s = knex.schema.withSchema('logistics');
  const hayEn = await s.hasColumn(TABLA, 'crew_saved_at');
  const hayPor = await knex.schema.withSchema('logistics').hasColumn(TABLA, 'crew_saved_by');
  if (hayEn || hayPor) {
    await knex.schema.withSchema('logistics').alterTable(TABLA, (t) => {
      if (hayEn) t.dropColumn('crew_saved_at');
      if (hayPor) t.dropColumn('crew_saved_by');
    });
  }
};
