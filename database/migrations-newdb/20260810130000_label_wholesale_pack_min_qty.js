/**
 * Etiquetera — umbral del mayoreo por paquete (Kepler kdpv_prod_util c4 del tier PAQ elegido).
 *
 * Agrega `commercial.product_label_prices.wholesale_pack_min_qty`. El importer toma el tier PAQ
 * MÁS BARATO (a menudo "desde 10"), así que sin guardar su min_qty la etiqueta imprimía "desde 3"
 * (default) con un precio que en realidad aplica desde 10 → umbral falso en la etiqueta impresa.
 * Con esta columna el tier "Mayoreo desde N paquetes: $X" muestra el N correcto.
 *
 * Idempotente (hasColumn). Aditiva. Requiere re-correr import-label-data.js para poblarla;
 * mientras esté NULL, la etiqueta rotula "Precio de mayoreo" sin umbral (honesto).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('product_label_prices', 'wholesale_pack_min_qty'))) {
    await knex.raw(`ALTER TABLE commercial.product_label_prices ADD COLUMN wholesale_pack_min_qty int`);
    await knex.raw(`COMMENT ON COLUMN commercial.product_label_prices.wholesale_pack_min_qty IS 'Umbral (min_qty) del tier PAQ elegido en kdpv_prod_util — paquetes mínimos para el precio de mayoreo por paquete.'`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('product_label_prices', 'wholesale_pack_min_qty')) {
    await knex.raw(`ALTER TABLE commercial.product_label_prices DROP COLUMN wholesale_pack_min_qty`);
  }
};
