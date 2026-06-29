/**
 * Segregación de funciones (SoD) — registra quién fijó manualmente el `final_qty`
 * de un ítem (resolveItem). `final_qty` mueve el dinero al reconciliar, así que
 * reconcile suma `resolved_by` a su set de segregación: quien resolvió un ítem no
 * puede autorizar el ajuste. Antes el set solo cubría a los contadores físicos.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('inventory_count_items', 'resolved_by');
  if (!has) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => {
      t.uuid('resolved_by');
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.inventory_count_items.resolved_by IS 'Usuario que fijó manualmente el final_qty (resolveItem). Entra en el set de segregación de funciones de reconcile.'`,
    );
  }
};

exports.down = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('inventory_count_items', 'resolved_by');
  if (has) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => {
      t.dropColumn('resolved_by');
    });
  }
};
