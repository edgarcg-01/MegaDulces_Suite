/**
 * Reconcile del conteo cíclico (no-congelado) — `book_at_count` guarda el saldo
 * EN LIBROS al momento del primer conteo de cada ítem. reconcile aplica un delta
 * relativo (saldo_actual + (contado − book_at_count)) en folios no-congelados, en
 * vez de un set absoluto, para no borrar las ventas ocurridas durante el conteo.
 * Null en conteos congelados (ahí reconcile sigue siendo set absoluto).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('inventory_count_items', 'book_at_count');
  if (!has) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => {
      t.decimal('book_at_count', 14, 3);
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.inventory_count_items.book_at_count IS 'Saldo en libros al PRIMER conteo (solo folios no-congelados). Baseline del delta relativo en reconcile, para preservar ventas ocurridas durante el conteo.'`,
    );
  }
};

exports.down = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('inventory_count_items', 'book_at_count');
  if (has) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => {
      t.dropColumn('book_at_count');
    });
  }
};
