'use strict';
/**
 * `[UB.RF.18]` — Un pasillo es un **corredor con dos frentes enfrentados** (Edgar, 2026-11-25): los
 * racks nones de un lado y los pares del otro. El orden de recorrido pasa de lineal (01, 02, 03…) a
 * **serpentina**: se baja por el frente de los nones y se vuelve por el de los pares.
 *
 * Esta migración recalcula `pick_sequence` de las ubicaciones que ya existen, para que no convivan dos
 * órdenes: el de las filas viejas y el que `defaultPickSequence` le pone a las nuevas.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-25) ────────────────────────────────────────
 *  · 531 ubicaciones con formato (CEDIS 375 + Padre Hidalgo 156), las dos en zona tienda.
 *  · **531 de 531 tienen EXACTAMENTE la fórmula vieja: 0 editadas a mano.** Por eso recalcular no
 *    pisa el trabajo de nadie. Si alguien hubiera corregido un recorrido a mano, esto lo borraría.
 *  · 0 ubicaciones con mercancía y 29 asignaciones vivas: el orden de surtido todavía no mueve a
 *    nadie en piso, que es justo por qué se cambia hoy y no dentro de un mes.
 *  · Efecto en el pasillo A de Padre Hidalgo, nivel 1: antes 01→02→03→04→05→06 (cinco cruces del
 *    corredor), ahora 01→03→05→06→04→02 (uno solo, en el fondo).
 *
 * ⚠️ Sólo hace UPDATE: no crea ningún objeto de esquema, así que la compuerta del despliegue la
 *    clasifica NO_MEDIDO y frena al equipo hasta que alguien la aplique. **Aplicar antes de mergear**
 *    con `apply-one-migration-prod.js`.
 *
 * Idempotente: recalcula de los datos de la propia fila, así que correrla dos veces da lo mismo.
 *
 * @param { import("knex").Knex } knex
 */

/** El `defaultPickSequence` de `@megadulces/contracts`, en SQL. Si cambia allá, cambia acá. */
const SERPENTINA = `
  (CASE zona WHEN 'T' THEN 0 ELSE 1 END) * 1000000
  + (ascii(upper(pasillo)) - 64) * 2 * 10000
  + (CASE WHEN rack % 2 = 1 THEN (rack + 1) / 2 ELSE 100 - rack / 2 END) * 10
  + nivel`;

/** La fórmula anterior: zona → pasillo → rack → nivel, de ida y en una sola fila. */
const LINEAL = `
  (CASE zona WHEN 'T' THEN 0 ELSE 1 END) * 1000000
  + (ascii(upper(pasillo)) - 64) * 2 * 10000
  + rack * 10
  + nivel`;

/** Sólo la familia que tiene pasillo, rack y nivel: carretas, contenedores y legado no se tocan. */
const ALCANCE = `
  familia = 'ubicacion'
  AND zona IS NOT NULL AND pasillo IS NOT NULL AND rack IS NOT NULL AND nivel IS NOT NULL
  AND pasillo ~ '^[A-Z]$'`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const r = await knex.raw(`UPDATE commercial.warehouse_bins SET pick_sequence = ${SERPENTINA} WHERE ${ALCANCE}`);
  console.log(`[UB.RF.18] recorrido en serpentina: ${r.rowCount} ubicacion(es) recalculadas`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve al recorrido lineal, sobre las mismas filas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const r = await knex.raw(`UPDATE commercial.warehouse_bins SET pick_sequence = ${LINEAL} WHERE ${ALCANCE}`);
  console.log(`[UB.RF.18] revertido a recorrido lineal: ${r.rowCount} ubicacion(es)`);
};
