/**
 * Horus — H2.1: Feature Store v2. Señales nuevas en execution_360 (explota el JSONB).
 *
 * Auditadas como bien pobladas (2026-06-17, 30d):
 *   - exec_level_score (0..100): calidad por NIVEL de ejecución (nivelEjecucion 94%),
 *     normalizando la rúbrica mixta (alto/excelente=1 · medio/estandar=0.6 ·
 *     bajo/basico=0.3 · crítico=0.1).
 *   - avg_visit_min: duración media de visita (hora_fin-hora_inicio, 100% poblado).
 *   - avg_skus: productos marcados por exhibición (99% poblado).
 *
 * Diferido por datos ausentes (audit): position-quality (scoring_pesos inaccesible),
 * coverage_pct (daily_assignments sin columna usable), roll-up por ruta (route_id 0%).
 * Idempotente: hasColumn antes de addColumn.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (c) => knex.schema.withSchema('commercial').hasColumn('execution_360', c);
  if (!(await has('exec_level_score'))) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.decimal('exec_level_score', 5, 2); // 0..100, calidad por nivel de ejecución
      t.decimal('avg_visit_min', 7, 2); // duración media de visita (min)
      t.decimal('avg_skus', 7, 2); // productos marcados por exhibición
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('execution_360', 'exec_level_score')) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.dropColumn('exec_level_score');
      t.dropColumn('avg_visit_min');
      t.dropColumn('avg_skus');
    });
  }
};
