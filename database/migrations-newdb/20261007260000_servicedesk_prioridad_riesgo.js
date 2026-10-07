'use strict';
/**
 * `[MS.7.7]` — La prioridad por modelo de cola: la matriz de Mantenimiento (riesgo para personas × detiene la operación).
 * `FASE_MS7_MANTENIMIENTO.md` (decisión M4).
 *
 * TI sugiere la prioridad con la matriz de IMPACTO (cuántas personas afecta × me impide trabajar). Mantenimiento hace dos
 * preguntas distintas: ¿hay riesgo para personas? y ¿detiene la operación? El modelo se elige por el **valor configurado** de la
 * cola (`queues.priority_model`, columna de `20261006130000`) — nunca por su nombre.
 *
 * ── Qué agrega ────────────────────────────────────────────────────────────────────────────────
 * · `requests.safety_risk boolean NULL`: la respuesta a «¿hay riesgo para personas?». **NULL = no se preguntó** (todo ticket de
 *   una cola de impacto, y todo lo anterior a esta migración): nunca un `false` inventado. «Detiene la operación» ya existía
 *   (`blocks_work`), así que no se duplica.
 * · La cola de Mantenimiento (si está sembrada y nadie le cambió el modelo) pasa a `riesgo_operacion`. Se hace AQUÍ y no en la
 *   siembra: el valor sólo se declara cuando el código ya aplica la matriz (la siembra se negó a clamarlo antes).
 *
 * Aditiva, idempotente y reversible. TI no cambia: su modelo sigue siendo `impacto` y `safety_risk` queda NULL.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const tiene = await knex.schema.withSchema('servicedesk').hasColumn('requests', 'safety_risk');
  if (!tiene) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN safety_risk boolean`);
  await knex.raw(
    `COMMENT ON COLUMN servicedesk.requests.safety_risk IS 'MS.7.7 — «¿hay riesgo para personas?», sólo en colas con priority_model = riesgo_operacion. NULL = no se preguntó (nunca un false inventado). Con blocks_work (detiene la operación) alimenta la prioridad sugerida.'`,
  );
  // Sólo si el modelo sigue en su valor de fábrica: lo que la coordinación ya ajustó no se pisa.
  const r = await knex.raw(`UPDATE servicedesk.queues SET priority_model = 'riesgo_operacion', updated_at = now()
                             WHERE code = 'mantenimiento' AND priority_model = 'impacto' AND deleted_at IS NULL`);
  // eslint-disable-next-line no-console
  console.log(`  [MS.7.7] requests.safety_risk ${tiene ? 'ya existía' : 'agregada'} · colas de Mantenimiento con el modelo riesgo × operación: ${r.rowCount ?? 0}`);
};

exports.down = async function down(knex) {
  await knex.raw(`UPDATE servicedesk.queues SET priority_model = 'impacto' WHERE code = 'mantenimiento' AND priority_model = 'riesgo_operacion'`);
  await knex.raw('ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS safety_risk');
};
