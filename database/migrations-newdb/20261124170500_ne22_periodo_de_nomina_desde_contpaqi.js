'use strict';
/**
 * Fase RH · frente NE · `[NE.2.2]` — EL PERIODO DE NÓMINA TAMBIÉN PUEDE VENIR DE ContPAQi.
 *
 * `hr.payroll_periods` nació en `[NE.0.4]` con `source IN ('access', 'suite', 'manual')`, porque
 * entonces las únicas fuentes imaginables eran el `.mdb` y la mano. Hoy hay una tercera, y está
 * **dentro de la base**: `contpaqi_ods.v_nomina_pago_periodo`.
 *
 * ⛔ La columna existe justamente para que el dato **declare de dónde salió** (ADR-056). Meter un
 * periodo derivado de ContPAQi como `'suite'` sería cierto a medias y borraría su procedencia: la
 * Suite lo *derivó*, pero quien lo sabe es ContPAQi.
 *
 * ── Lo medido antes (prod, sólo lectura, `system_identifier` verificado, 2026-11-24) ──────────
 *  · **517 fechas de pago** de nómina ordinaria (`payroll_type = 'O'`), de 2017-01-06 a 2026-11-20.
 *  · ⭐ **516 de 517 caen en viernes.** La única excepción en diez años es **2018-03-28, miércoles
 *    de Semana Santa** (el Viernes Santo caía el 30): se adelantó el pago. El `CHECK` del viernes
 *    que trae la tabla es correcto —y esta migración NO lo toca—, pero ⚠️ **va a rechazar esa
 *    fecha cuando se cargue el histórico** (`[NE.0.7]`): queda avisado acá y allá.
 *  · ⭐⭐ **El rango de días SÍ está registrado**, al revés de lo que supuso `[NE.0.4]` (que lo
 *    declaró desconocido y por eso `starts_on`/`ends_on` nacen NULL). Cada pago trae su
 *    `period_from`/`period_to`; no son iguales entre personas —quien entra o sale a media semana
 *    trae el suyo— pero el **rango modal de cada fecha** cubre en promedio el **98.2 %** de sus
 *    pagos, nunca menos del **90.4 %**, y en **516 de 517** fechas es de **7 días que terminan el
 *    día del pago**: la semana de nómina es **sábado → viernes**, y se paga el viernes.
 *  · La nómina **extraordinaria** (`'E'`) paga cualquier día y se concentra en **junio** (PTU) y
 *    **diciembre** (aguinaldo). ⛔ **No es un periodo semanal y no entra acá**: meterla rompería
 *    el viernes y, peor, haría que «la semana» signifique dos cosas.
 *
 * Aditiva: sólo ensancha un `CHECK`. No toca filas (la tabla está en 0) ni ninguna otra columna.
 * ⚠️ Ensanchar un `CHECK` es compatible hacia atrás: lo que era válido lo sigue siendo, así que
 * aplicarla antes de desplegar el código que la usa no rompe nada.
 *
 * Idempotente: se puede correr dos veces y la segunda deja lo mismo.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'payroll_periods';
const CK = `${T}_source_ck`;
const VIEJO = `source IN ('access', 'suite', 'manual')`;
const NUEVO = `source IN ('access', 'suite', 'manual', 'contpaqi')`;

/** ¿La restricción acepta ya ese valor? Se lee del catálogo, no se supone. */
async function aceptaContpaqi(knex) {
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.conrelid = 'hr.${T}'::regclass AND c.conname = ?`,
    [CK],
  );
  return rows.length > 0 && /contpaqi/i.test(String(rows[0].def));
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await aceptaContpaqi(knex)) {
    console.log(`  [ne22] hr.${T}.source ya acepta 'contpaqi': nada que hacer.`);
    return;
  }
  await knex.raw(`ALTER TABLE hr.${T} DROP CONSTRAINT IF EXISTS ${CK}`);
  await knex.raw(`ALTER TABLE hr.${T} ADD CONSTRAINT ${CK} CHECK (${NUEVO})`);
  await knex.raw(`COMMENT ON COLUMN hr.${T}.source IS
    'De dónde salió el periodo: access = el padrón viejo · contpaqi = derivado de contpaqi_ods.v_nomina_pago_periodo (la semana sábado→viernes que ese sistema declara) · suite = lo calculó la Suite · manual = lo escribió una persona.'`);
  console.log(`  [ne22] hr.${T}.source ahora acepta 'contpaqi'.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, y se niega si ya hay filas que dependan del valor nuevo. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await aceptaContpaqi(knex))) return;
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS n FROM hr.${T} WHERE source = 'contpaqi'`);
  if (n.n > 0) {
    throw new Error(
      `[ne22] down: hay ${n.n} periodo(s) con source = 'contpaqi'. Estrechar el CHECK los dejaría ` +
        `inválidos. Decidí primero qué pasa con ellos.`,
    );
  }
  await knex.raw(`ALTER TABLE hr.${T} DROP CONSTRAINT IF EXISTS ${CK}`);
  await knex.raw(`ALTER TABLE hr.${T} ADD CONSTRAINT ${CK} CHECK (${VIEJO})`);
};
