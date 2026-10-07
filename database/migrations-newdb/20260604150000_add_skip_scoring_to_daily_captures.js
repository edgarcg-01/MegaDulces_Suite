/**
 * Agrega skip_scoring a trade.daily_captures.
 *
 * Bandera para crear visitas SIN ponderación (sin scoring de auditoría). La usa
 * la "captura diaria especial del vendedor": el vendedor registra foto de
 * exhibidor + productos del ticket que matchean el planograma, pero esa visita
 * NO debe contar para el scoring de trade marketing. Cuando skip_scoring=true,
 * el service persiste config_version_id/score_maximo/score_final_pct en NULL.
 *
 * NOTA: la tabla vive en `trade.daily_captures` (movida en 20260604110000);
 * `public.daily_captures` es una VISTA → no se puede ALTER. Target = trade.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('trade.daily_captures', 'skip_scoring');
  if (hasColumn) return;

  await knex.schema.withSchema('trade').alterTable('daily_captures', (table) => {
    table.boolean('skip_scoring').notNullable().defaultTo(false);
  });

  await knex.raw(`
    COMMENT ON COLUMN trade.daily_captures.skip_scoring IS
      'true = visita sin ponderación (no cuenta para scoring de auditoría). '
      'Usado por la captura del vendedor: score_* quedan NULL.'
  `);
};

exports.down = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('trade.daily_captures', 'skip_scoring');
  if (hasColumn) {
    await knex.schema.withSchema('trade').alterTable('daily_captures', (table) => {
      table.dropColumn('skip_scoring');
    });
  }
};
