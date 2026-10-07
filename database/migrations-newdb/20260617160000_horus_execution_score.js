/**
 * Horus — H2.3: motor multi-señal. Score de ejecución explicable en execution_360.
 *
 * `exec_score` (0..100) = combinación ponderada de señales normalizadas (calidad,
 * tendencia, foto, share propio, integridad de fraude para colaboradores; share,
 * calidad, frescura para tiendas). `exec_score_breakdown` (JSONB) guarda la
 * contribución de cada señal → explicable ("lo que más resta"). El motor decide y
 * explica; cero LLM. Idempotente: hasColumn antes de addColumn.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (c) => knex.schema.withSchema('commercial').hasColumn('execution_360', c);
  if (!(await has('exec_score'))) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.decimal('exec_score', 5, 2); // salud de ejecución 0..100 (null si datos insuficientes)
      t.jsonb('exec_score_breakdown'); // [{ key, label, value, weight, contribution }] ordenado peor→mejor
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('execution_360', 'exec_score')) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.dropColumn('exec_score');
      t.dropColumn('exec_score_breakdown');
    });
  }
};
