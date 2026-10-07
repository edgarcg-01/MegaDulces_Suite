/**
 * Fase I.5 (P1) — umbral de recuento (count-back) por folio.
 *
 * `recount_threshold_pct`: si > 0, en `computeDiscrepancies` un item cuyos conteos
 * COINCIDEN (o no-blind con un solo conteo) pero cuya |varianza vs teórico| excede
 * `expected_qty * pct/100` NO se auto-resuelve: queda como `discrepancy` para forzar
 * recuento o revisión del supervisor antes de mover el saldo (control de inventario
 * estándar: out-of-tolerance ⇒ count-back).
 *
 * Default 0 = feature OFF (comportamiento previo: todo conteo coincidente se
 * auto-resuelve). Aditivo e idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'recount_threshold_pct'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => {
      t.decimal('recount_threshold_pct', 6, 2).notNullable().defaultTo(0);
    });
    await knex.raw(`COMMENT ON COLUMN commercial.inventory_counts.recount_threshold_pct IS 'Umbral % de varianza para forzar recuento. >0: conteos coincidentes fuera de tolerancia (|varianza| > expected*pct/100) quedan en discrepancy en vez de auto-resolver. 0 = off.'`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'recount_threshold_pct')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => t.dropColumn('recount_threshold_pct'));
  }
};
