'use strict';
/**
 * `[PVI.3]` — El supuesto de crecimiento se guardaba SIN su procedencia.
 *
 * `proposeGrowth` calcula, por canal, `basis` (`yoy_paired` | `global` | `default`),
 * `paired_periods`, `years_used` y la cobertura del pareo… y `budget.sales_plan_settings`
 * guarda **sólo el número**: `growth_by_channel` es un jsonb de valores pelados
 * (`{"ruta":0.0826,"mayoreo":0.2667,…}`). El autopilot lo descarta explícitamente en
 * `budget-autopilot.service.ts:293`, que lee `.growth_pct` y tira el resto.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-08) ────────────────────────────────────────
 *  · Los 4 canales del ejercicio vivo tienen número y **ninguno** tiene procedencia.
 *  · `mayoreo` quedó en **0.2667 = el `default_growth_pct` al decimal**. Eso es la huella de
 *    `basis:'default'` — su YoY no se pudo calcular — y **sólo se descubre recomputando**,
 *    porque la tabla no lo dice. Con el pareo por entidad ese canal mide **−9.36 %**: el
 *    presupuesto le puso +26.67 % a un canal que CAE. 28.10 % de la meta ($169,970,622).
 *  · Tampoco se distingue un supuesto DERIVADO de uno puesto a mano: el autopilot respeta lo
 *    ya guardado (`yaGuardado[canal] == null`) y después nadie puede saber cuál fue cuál.
 *
 * ⭐ Por eso la columna NO es cosmética: hoy un número refutado y uno defendible se ven igual.
 *    ADR-056 — el número carga con qué se calculó. `VERDAD_ABSOLUTA` §24.7.
 *
 * Aditiva y nullable a propósito: las filas que ya existen quedan en NULL, que es la verdad
 * (se guardaron sin procedencia y nadie puede reconstruirla sin recomputar). **NULL no se
 * rellena con un valor inventado** — un `{}` se leería como «se midió y no había nada».
 *
 * No toca `growth_by_channel`: cambiarle la forma rompería a todos sus lectores (el autopilot,
 * `proposePlan` y la pantalla). La procedencia va AL LADO, misma llave de canal.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'budget.sales_plan_settings';
const COL = 'growth_provenance';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const existe = await knex.schema.withSchema('budget').hasColumn('sales_plan_settings', COL);
  if (!existe) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN ${COL} jsonb`);
  }

  await knex.raw(`
    COMMENT ON COLUMN ${TABLA}.${COL} IS
    '[PVI.3] Procedencia de growth_by_channel, misma llave de canal: {basis, paired_periods, years_used, cobertura}. basis: yoy_paired (medido) | global (heredó el del total) | default (NO se pudo medir) | manual (lo puso una persona). NULL = la fila se guardó antes de PVI.3 y su procedencia NO se puede reconstruir sin recomputar — no es {} ni "sin procedencia", es desconocida.'`);

  // La columna nace VACÍA a propósito: ninguna fila existente puede declarar una procedencia
  // que nadie midió. Se puebla sola en la próxima pasada del autopilot.
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const existe = await knex.schema.withSchema('budget').hasColumn('sales_plan_settings', COL);
  if (existe) await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN ${COL}`);
};
