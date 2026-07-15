/**
 * HIQ.2 (Fase Horus-IQ) — Umbrales contextuales: columnas de gobierno.
 *
 * `auto_tuned_at` = última vez que AdaptiveThresholdsService recalculó la fila
 * desde los percentiles del propio tenant. `manual_lock` = pin humano: si está
 * en true, el learner NO pisa los valores (mismo principio que el
 * manual_override de la calibración L2, ADR-021).
 *
 * Idempotente (hasColumn). Aditiva.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('commercial').hasColumn('execution_thresholds', col);
  if (!(await has('auto_tuned_at'))) {
    await knex.schema.withSchema('commercial').alterTable('execution_thresholds', (t) => {
      t.timestamp('auto_tuned_at');
    });
  }
  if (!(await has('manual_lock'))) {
    await knex.schema.withSchema('commercial').alterTable('execution_thresholds', (t) => {
      t.boolean('manual_lock').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  const has = (col) => knex.schema.withSchema('commercial').hasColumn('execution_thresholds', col);
  if (await has('auto_tuned_at')) {
    await knex.schema.withSchema('commercial').alterTable('execution_thresholds', (t) => t.dropColumn('auto_tuned_at'));
  }
  if (await has('manual_lock')) {
    await knex.schema.withSchema('commercial').alterTable('execution_thresholds', (t) => t.dropColumn('manual_lock'));
  }
};
