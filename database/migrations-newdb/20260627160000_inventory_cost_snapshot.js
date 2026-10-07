/**
 * #14 — congelar el costo al reconciliar. El valor de la merma se calculaba con el
 * cost_base ACTUAL, así que derivaba al cambiar el costo después del conteo. Ahora:
 *   - inventory_count_items.unit_cost: costo unitario fotografiado al reconciliar.
 *   - inventory_counts.net_variance_value / variance_value_abs: resumen de valor de
 *     varianza por folio (firmado y absoluto), autoritativo y sin recálculo.
 * El hook GL/COGS completo queda diferido post-beta.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'unit_cost'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => {
      t.decimal('unit_cost', 14, 4);
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.inventory_count_items.unit_cost IS 'Costo unitario congelado al reconciliar — el valor de la merma no deriva si cambia cost_base después.'`,
    );
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'net_variance_value'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => {
      t.decimal('net_variance_value', 14, 2);
      t.decimal('variance_value_abs', 14, 2);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'unit_cost')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => t.dropColumn('unit_cost'));
  }
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'net_variance_value')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => {
      t.dropColumn('net_variance_value');
      t.dropColumn('variance_value_abs');
    });
  }
};
