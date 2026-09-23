'use strict';
/**
 * `[COT.1.1]` — El vocabulario de `quote_lines.price_source` admite los DOS mecanismos de
 * promoción del ERP, que hasta ahora no tenían cómo nombrarse.
 *
 * El CHECK original (`[E.12.0]`) cerró el dominio en siete valores:
 *   list · customer_terms · volume_qty · volume_amount · free_goods · manual · unknown
 *
 * Cerrarlo estuvo bien —es lo que hizo que el motor fallara ruidosamente en vez de escribir
 * etiquetas inventadas— pero le faltan dos, y no son sinónimos de las que hay:
 *
 *   · `volume_qty`  = **otro PRECIO** del mismo peldaño a partir de N unidades. Es la escalera
 *                     de mayoreo del propio Kepler (`kdpv_prod_util`), la que ya viaja en
 *                     `v_label_prices.wholesale_*`.
 *   · `promo_qty`   = un **% de descuento** sobre el precio vigente, con umbral y **vigencia**
 *                     (`kdpv_descuxq`). Tiene fecha de caducidad y saldo; la escalera no.
 *
 * Meterlos en la misma etiqueta haría imposible contestar *"¿este renglón se abarató porque
 * compró más, o porque había una promo que ya venció?"* — que es justo la pregunta al recotizar
 * (COT.5). Lo mismo para `promo_amount` (`kdpv_descuxm`) frente a `volume_amount`.
 *
 * Es **aditiva**: ninguna fila existente cambia de valor, y los siete de antes siguen siendo
 * válidos. Se reescribe el CHECK entero porque Postgres no sabe "agregar un valor" a uno.
 *
 * @param { import("knex").Knex } knex
 */
const VALORES = [
  'list',
  'customer_terms',
  'volume_qty',
  'volume_amount',
  'promo_qty',
  'promo_amount',
  'free_goods',
  'manual',
  'unknown',
];

exports.up = async function (knex) {
  await knex.raw(
    `ALTER TABLE commercial.quote_lines DROP CONSTRAINT IF EXISTS commercial_quote_lines_price_source_valid`,
  );
  await knex.raw(
    `ALTER TABLE commercial.quote_lines
       ADD CONSTRAINT commercial_quote_lines_price_source_valid
       CHECK (price_source IN (${VALORES.map((v) => `'${v}'`).join(', ')}))`,
  );
  await knex.raw(
    `COMMENT ON COLUMN commercial.quote_lines.price_source IS
     'De donde salio el precio del renglon. list = precio de lista del peldano (kdii). volume_qty = otro PRECIO por volumen del ERP (kdpv_prod_util, sin vigencia). promo_qty = % de descuento con umbral y VIGENCIA (kdpv_descuxq). volume_amount/promo_amount = sus hermanos por monto. free_goods = renglon regalado (su cero es legitimo). customer_terms = descuento del cliente, que es capa DOCUMENTO y no deberia aparecer en un renglon. unknown = sin precio o sin casar, con el motivo en notes/availability.'`,
  );
};

exports.down = async function (knex) {
  await knex.raw(
    `ALTER TABLE commercial.quote_lines DROP CONSTRAINT IF EXISTS commercial_quote_lines_price_source_valid`,
  );
  await knex.raw(
    `ALTER TABLE commercial.quote_lines
       ADD CONSTRAINT commercial_quote_lines_price_source_valid
       CHECK (price_source IN ('list','customer_terms','volume_qty','volume_amount','free_goods','manual','unknown'))`,
  );
};
