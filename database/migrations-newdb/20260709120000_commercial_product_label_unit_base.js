/**
 * Etiquetera — unidad base de venta por producto (Kepler kdii.c11).
 *
 * Agrega `commercial.product_label_prices.unit_base` (PZA/PAQ/KG/CJA/…). Define el
 * título y valor del precio grande de la etiqueta ("Precio por pieza/paquete/kg/caja"):
 *   PZA→c90 (pieza) · PAQ→c91 (paquete) · KG→c90 ($/kg) · CJA→c92 (caja).
 *
 * Nombre a propósito `..._label_unit_base` (ordena entre `..._label_prices` ya aplicada
 * y `..._ra_purchasing_flow` pendiente) para poder aplicar SOLO esta con `migrate:up`
 * en Railway sin arrastrar las migraciones de Compras/RA. Idempotente (hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('product_label_prices', 'unit_base'))) {
    await knex.raw(`ALTER TABLE commercial.product_label_prices ADD COLUMN unit_base varchar(8)`);
    await knex.raw(`COMMENT ON COLUMN commercial.product_label_prices.unit_base IS 'Unidad base de venta (kdii.c11): PZA/PAQ/KG/CJA/… — define título y valor del precio grande.'`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('product_label_prices', 'unit_base')) {
    await knex.raw(`ALTER TABLE commercial.product_label_prices DROP COLUMN unit_base`);
  }
};
