/**
 * RA-PRO.14 — `analytics.sales_daily.units_base`: unidad CANÓNICA de la venta en CAJAS.
 *
 * `sales_daily.units` mezcla unidades por canal (ver reference_box_factor_factor_sale):
 * Wincaja (`wincaja_*`) vende CAJAS, el POS Kepler (`tienda`/`credito`) vende PIEZAS sueltas
 * — y a veces cajas. Sumar `units` a ciegas infla la demanda (globos, factor 100-150) y con
 * ella el reabasto. `units_base` normaliza cada fila a CAJAS (stock/costo/compras viven en
 * cajas), poblado por `import-sales-units-base.js`. Consumido por import-inventory-health
 * (demanda → reorden) y cualquier métrica por-unidad.
 *
 * Aditiva, idempotente, solo columna nullable (no rompe boot ni feeds existentes).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasColumn('sales_daily', 'units_base'))) {
    await knex.schema.withSchema('analytics').alterTable('sales_daily', (t) => {
      t.decimal('units_base').comment('venta normalizada a CAJAS (unidad canónica); poblada por import-sales-units-base.js');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('analytics').hasColumn('sales_daily', 'units_base')) {
    await knex.schema.withSchema('analytics').alterTable('sales_daily', (t) => t.dropColumn('units_base'));
  }
};
