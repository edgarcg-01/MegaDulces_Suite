'use strict';
/**
 * `[RH.13.7]` — «Corporativo» y «Corporativo Comida» son UNA plaza: se apaga la segunda.
 *
 * Son la misma gente checando en dos relojes de oficinas. El de comida numera distinto (el patrón
 * es +100, con dos códigos cruzados), así que en Mega Talento tuvo plaza propia hasta que se fundió
 * con una tabla de traducción y la plaza salió de su selector (`CENTROS_SIN_RELOJ`). En la Suite esa
 * fusión YA está en los datos: el reloj de comida pertenece a `corporativo` y cada enrolamiento
 * lleva su `person_code` traducido, así que la comida sale en la misma fila que la jornada.
 *
 * Lo que sobraba es la plaza vieja: la carga única de Mega Talento creó un sitio por cada
 * `sucursal_id` que vio (también en checadas viejas y padrones inactivos), todos activos, e ignoró
 * la lista de plazas ocultas. Por eso aparecía en el selector una plaza sin reloj, con un padrón
 * duplicado de la gente de corporativo.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-13) ────────────────────────────────────────
 *  · `corporativo-comida`: ningún reloj activo (sólo el «reloj desconocido» de la carga, en pausa);
 *    8 checadas de 2 códigos, la última del 21-ago; 0 incidencias, 0 cierres, 0 horarios, 0 reglas.
 *  · El reloj de comida real está en `corporativo` y recibe marcas hoy: 38 enrolamientos traducidos,
 *    37 caen en la misma persona de la Suite que en el reloj de entrada; los 10 sin traducir no
 *    existen en el reloj de entrada y no tienen marcas en 30 días (ninguna marca va a otra persona).
 *
 * Se DESACTIVA, no se borra: conserva sus 8 marcas históricas y su padrón. Desactivada sale del
 * selector de plazas y de «Buscar en todas las plazas».
 *
 * ⛔ Si algún reloj ACTIVO sigue apuntando a `corporativo-comida`, la migración se niega: apagar la
 *    plaza escondería sus marcas nuevas (en Mega Talento eso pasó cinco días, ~96 marcas diarias).
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA hasta que se
 *    aplique a mano. Aplicala ANTES de mergear.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SITIO = 'corporativo-comida';
const MARCA = '[RH.13.7] fundida en corporativo';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: activos } = await knex.raw(
    `SELECT count(*)::int AS n FROM hr.attendance_devices WHERE tenant_id = ?::uuid AND site_code = ? AND is_active`,
    [TENANT, SITIO]);
  if (activos[0].n > 0) {
    throw new Error(`[RH.13.7] ${activos[0].n} reloj(es) activo(s) siguen en ${SITIO}: muévelos a corporativo con su person_code antes de apagar la plaza.`);
  }
  const r = await knex.raw(
    `UPDATE hr.attendance_sites
        SET is_active = false, updated_at = now(), notes = concat_ws(' · ', nullif(notes, ''), ?::text)
      WHERE tenant_id = ?::uuid AND code = ? AND is_active`,
    [MARCA, TENANT, SITIO]);
  console.log(`[RH.13.7] plazas desactivadas: ${r.rowCount} (1 la primera vez; 0 si ya corrió o no existe)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: sólo la plaza que lleva su marca. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE hr.attendance_sites
        SET is_active = true, updated_at = now(),
            notes = nullif(replace(replace(notes, ' · ' || ?::text, ''), ?::text, ''), '')
      WHERE tenant_id = ?::uuid AND code = ? AND NOT is_active AND position(?::text IN coalesce(notes, '')) > 0`,
    [MARCA, MARCA, TENANT, SITIO, MARCA]);
};
