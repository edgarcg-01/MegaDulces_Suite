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
 * que necesite (no hay dato que preservar). DROP IF EXISTS sin CASCADE.
 * `down` = no-op.
 *
 * ⚠️ Cada tabla trade tiene una VISTA shim `public.*` legacy encima (pass-through `SELECT * FROM`,
 * patrón v1). Verificado 2026-09-11: las 3 vistas tienen 0 referencias en apps/libs. Hay que tirar
 * la vista ANTES de la tabla (sin la vista, el DROP TABLE falla "other objects depend on it" — de
 * hecho falló así en la 1ª aplicación, el diseño sin-CASCADE lo hizo ruidoso). Sin CASCADE a
 * propósito: si mañana algo dependiera, que truene, no que arrastre.
 * @param { import("knex").Knex } knex
 */
const DEAD_VIEWS = [
  'public.valid_exhibition_combinations',
  'public.rubric_levels',
  'public.rubric_criteria',
];
const DEAD = [
  'trade.valid_exhibition_combinations',
  'trade.rubric_levels',
  'trade.rubric_criteria',
];

exports.up = async function (knex) {
  for (const v of DEAD_VIEWS) {
    await knex.raw(`DROP VIEW IF EXISTS ${v}`);
    console.log(`  DROP VIEW ${v}`);
  }
  for (const t of DEAD) {
    await knex.raw(`DROP TABLE IF EXISTS ${t}`);
    console.log(`  DROP TABLE ${t}`);
  }
};

exports.down = async function () {
  // Tablas dead-on-arrival (0 filas, 0 refs): no se recrean acá. No-op a propósito.
};
