/**
 * Fase P2.6 — Control de Caducidades: ubicación física.
 *
 * Agrega dónde está la mercancía inspeccionada (anaquel / bodega / exhibidor / etc.):
 *   - commercial.expiry_reviews.default_location  → ubicación por defecto de la hoja.
 *   - commercial.expiry_review_lines.location     → ubicación por renglón (hereda el default
 *     al capturar, editable — un promotor puede tener el mismo SKU en varios puntos).
 *
 * Aditivo e idempotente (guard hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('expiry_reviews', 'default_location'))) {
    await knex.schema.withSchema('commercial').alterTable('expiry_reviews', (t) => {
      t.string('default_location', 120);
    });
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('expiry_review_lines', 'location'))) {
    await knex.schema.withSchema('commercial').alterTable('expiry_review_lines', (t) => {
      t.string('location', 120);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('expiry_review_lines', 'location')) {
    await knex.schema.withSchema('commercial').alterTable('expiry_review_lines', (t) => t.dropColumn('location'));
  }
  if (await knex.schema.withSchema('commercial').hasColumn('expiry_reviews', 'default_location')) {
    await knex.schema.withSchema('commercial').alterTable('expiry_reviews', (t) => t.dropColumn('default_location'));
  }
};
