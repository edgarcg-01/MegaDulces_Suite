/**
 * Etiquetera — marca si el producto TIENE presentación en kilos (se muestra "Precio por kg").
 *
 * `commercial.product_label_prices.sold_by_kg` = true si Kepler marca la base como KG
 * (kdii.c11='KG') o el SKU tiene un tier `present='KG'` en kdpv_prod_util. Antes, cualquier
 * unit_base numérico (250/500/400) se trataba como granel y se le fabricaba un "$/kg" dividiendo
 * — mal para bolsas/palitos que NO se venden por kilo (ej. 68521 PALO, POLIPRO). Con este flag
 * el "$/kg" solo sale cuando existe presentación real en kilos.
 *
 * Idempotente (hasColumn). Aditiva. Requiere re-correr import-label-data.js para poblarla;
 * mientras esté NULL/false, el producto NO muestra $/kg (fallback a "Precio por pieza").
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('product_label_prices', 'sold_by_kg'))) {
    await knex.raw(`ALTER TABLE commercial.product_label_prices ADD COLUMN sold_by_kg boolean NOT NULL DEFAULT false`);
    await knex.raw(`COMMENT ON COLUMN commercial.product_label_prices.sold_by_kg IS 'El producto tiene presentación en kilos (kdii.c11=KG o tier present=KG en kdpv) → la etiqueta muestra "Precio por kg".'`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('product_label_prices', 'sold_by_kg')) {
    await knex.raw(`ALTER TABLE commercial.product_label_prices DROP COLUMN sold_by_kg`);
  }
};
