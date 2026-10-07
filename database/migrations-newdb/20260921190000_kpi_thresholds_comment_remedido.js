'use strict';
/**
 * `[CDRP.2]` — **Reemitir el `COMMENT ON TABLE` de `analytics.kpi_thresholds`: la medición que
 * llevaba adentro envejeció en tres días.**
 *
 * ── Por qué esto es una migración y no una edición de comentario ─────────────────────────────
 * El texto viejo afirmaba: *«Nace VACIA porque no existe ninguna meta: las 6 tablas de presupuesto
 * tienen 0 filas (2026-09-18)»*. Eso está **persistido en el catálogo de Postgres de prod**
 * (`pg_description`), no sólo en el archivo fuente. Y `20260921120000_analytics_kpi_thresholds.js`
 * ya corrió (batch 495): editar su texto no vuelve a ejecutarse nunca y prod se quedaría
 * repitiendo el dato viejo a quien haga `\d+ analytics.kpi_thresholds`.
 *
 * ⛔ La trampa que esto evita es la de siempre en este repo, con otro disfraz: **una afirmación
 * medida, con fecha, que sigue publicándose después de dejar de ser cierta.** Un comentario de
 * tabla es documentación que el DBA lee como verdad; si miente, miente con autoridad.
 *
 * ── Qué cambió entre el 18 y el 21 de septiembre de 2026 ─────────────────────────────────────
 * Re-medido contra prod (solo lectura) el 2026-09-21. La frase era falsa por DOS lados:
 *
 *   · **No son 6 tablas, son 13.** La Fase PU (ADR-075) agregó `budget.sales_plan_lines`,
 *     `budget.sales_plan_settings`, `budget.expense_plan_lines`, `budget.expense_plan_settings`,
 *     `budget.campaigns`, `budget.campaign_contributions` y `budget.daily_capacity_history`.
 *   · **Tres ya tienen filas.** `budget.budgets` 2 (una FY2027 «presupesto» en borrador, creada
 *     el 2026-09-21 a las 17:21Z), `budget.sales_plan_settings` 1 (método híbrido, crecimiento
 *     por canal) y `budget.expense_plan_settings` 1. Alguien está armando el presupuesto AHORA.
 *
 * ── Y sin embargo la tabla sigue naciendo vacía, por la misma razón de fondo ─────────────────
 * Lo que existe son **encabezados y parámetros de método**, no metas. Los renglones siguen en 0:
 * `budget.sales_plan_lines` 0 · `budget.budget_lines` 0 · `budget.expense_plan_lines` 0 ·
 * `commercial.sales_targets` 0. Sin un renglón no hay contra qué comparar, así que
 * `clasificarKpi()` devuelve `sin_meta` para todo — que sigue siendo lo que hoy es cierto.
 *
 * ⭐ **Lo que la re-medición sí destrabó:** estaba abierto de dónde iba a salir la meta de ventas.
 * Sale de `budget.sales_plan_lines` (`budget_id, entity_key, period_no, meta_amount, method,
 * growth_pct, base_amount`), **no** de `commercial.sales_targets` — que tiene la forma exacta y
 * cero escritores. Cuando se siembre el primer umbral de ventas, su `source` apunta ahí.
 *
 * ⚠️ Esta migración **sólo reescribe un comentario**: no toca datos, ni estructura, ni permisos.
 * Es idempotente por naturaleza y su `down` restituye el texto anterior tal cual estaba.
 *
 * @param { import("knex").Knex } knex
 */

const FULL = 'analytics.kpi_thresholds';

/*
 * ⛔ `COMMENT ON` NO admite parámetros: `COMMENT ON TABLE x IS ?` da
 * `syntax error at or near "$1"`. Es la misma familia del bug que ya cobró en la migración de
 * origen (ahí fue `IS 'a' || 'b'`): la sentencia exige un **literal**, no una expresión ni un
 * binding. Se escapa a mano, duplicando la comilla simple como manda SQL.
 */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** El texto anterior, palabra por palabra, para que el `down` sea de verdad reversible. */
const COMENTARIO_VIEJO =
  '[CDRP.2] Contra que se juzga cada indicador directivo: una FILA por (kpi, puesto, periodo). ' +
  'position_code NULL = aplica a todos; la fila con puesto gana. target/warn_at/escalate_at son ' +
  'ABSOLUTOS (el porcentaje se rompe con meta 0, que es un objetivo real) y un CHECK impide que ' +
  'queden incoherentes. manual_lock + auto_tuned_at heredados de commercial.execution_thresholds ' +
  '(Horus HIQ.2, ADR-021): el auto-calibrador no pisa lo que un humano fijo. ' +
  'SIN FILA no hay semaforo: el clasificador devuelve sin_meta, nunca ok (ADR-056). ' +
  'Nace VACIA porque no existe ninguna meta: las 6 tablas de presupuesto tienen 0 filas (2026-09-18).';

const COMENTARIO_NUEVO =
  '[CDRP.2] Contra que se juzga cada indicador directivo: una FILA por (kpi, puesto, periodo). ' +
  'position_code NULL = aplica a todos; la fila con puesto gana. target/warn_at/escalate_at son ' +
  'ABSOLUTOS (el porcentaje se rompe con meta 0, que es un objetivo real) y un CHECK impide que ' +
  'queden incoherentes. manual_lock + auto_tuned_at heredados de commercial.execution_thresholds ' +
  '(Horus HIQ.2, ADR-021): el auto-calibrador no pisa lo que un humano fijo. ' +
  'SIN FILA no hay semaforo: el clasificador devuelve sin_meta, nunca ok (ADR-056). ' +
  'Nace VACIA porque no existe ninguna meta POR RENGLON: al 2026-09-21 hay encabezados de ' +
  'presupuesto (budget.budgets 2 filas, una FY2027 en borrador) pero los renglones siguen en 0 ' +
  '(budget.sales_plan_lines, budget_lines, expense_plan_lines, commercial.sales_targets). ' +
  'La meta de ventas saldra de budget.sales_plan_lines, no de commercial.sales_targets.';

exports.up = async function up(knex) {
  // Si la tabla no existe (réplica que nunca corrió CDRP.2), no hay nada que corregir y no es un
  // error: la migración de origen la creará con el texto ya bueno cuando corra.
  const hay = await knex.raw(`SELECT to_regclass(?) AS t`, [FULL]);
  if (!hay.rows[0] || !hay.rows[0].t) {
    console.log(`  [CDRP.2] ${FULL} no existe todavía — nada que reemitir`);
    return;
  }

  await knex.raw(`COMMENT ON TABLE ${FULL} IS ${lit(COMENTARIO_NUEVO)}`);

  /*
   * Prueba positiva en la propia migración: si el comentario no quedó, no sirve de nada haber
   * corrido. Se verifica leyéndolo de vuelta del catálogo, no asumiendo que el ALTER funcionó.
   */
  const leido = await knex.raw(`SELECT obj_description(?::regclass) AS c`, [FULL]);
  const c = (leido.rows[0] && leido.rows[0].c) || '';
  if (/6 tablas de presupuesto/.test(c)) {
    throw new Error('[CDRP.2] el COMMENT ON TABLE sigue con la medición vencida');
  }
  console.log('  [CDRP.2] COMMENT ON TABLE reemitido con la medición del 2026-09-21');
};

exports.down = async function down(knex) {
  const hay = await knex.raw(`SELECT to_regclass(?) AS t`, [FULL]);
  if (!hay.rows[0] || !hay.rows[0].t) return;
  await knex.raw(`COMMENT ON TABLE ${FULL} IS ${lit(COMENTARIO_VIEJO)}`);
};
