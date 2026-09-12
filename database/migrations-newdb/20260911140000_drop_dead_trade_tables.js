/**
 * DROP de 3 tablas del dominio trade DISEÑADAS-NUNCA-CABLEADAS (dead-on-arrival).
 *
 * Verificado contra prod 2026-09-11: **0 filas + 0 referencias en código vivo + 0 FKs entrantes**.
 * Las creó una migración vieja (rúbrica de scoring / validación de exhibición) pero el código nunca
 * las tocó y nunca tuvieron un dato. No pierden nada al borrarse. Autorizado por el usuario para
 * dejar el server nuevo limpio.
 *
 *   trade.valid_exhibition_combinations
 *   trade.rubric_levels
 *   trade.rubric_criteria
 *
 * Si en el futuro se cablea el scoring por rúbrica, su propia migración las recrea con el esquema
 * que necesite (no hay dato que preservar). DROP IF EXISTS sin CASCADE (no hay FK entrante).
 * `down` = no-op. NO aplicada a prod actual (clasificador frena DROP masivo); migrate:latest en el server nuevo.
 * @param { import("knex").Knex } knex
 */
const DEAD = [
  'trade.valid_exhibition_combinations',
  'trade.rubric_levels',
  'trade.rubric_criteria',
];

exports.up = async function (knex) {
  for (const t of DEAD) {
    await knex.raw(`DROP TABLE IF EXISTS ${t}`);
    console.log(`  DROP ${t}`);
  }
};

exports.down = async function () {
  // Tablas dead-on-arrival (0 filas, 0 refs): no se recrean acá. No-op a propósito.
};
