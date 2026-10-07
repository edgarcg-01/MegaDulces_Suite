/**
 * RA-PRO.39 — `analytics.product_box_price`: precio de LISTA de la CAJA (CJA) por producto,
 * desde Kepler `kdpv_prod_util` (presentación 'CJA'). Base de la conversión ROBUSTA a cajas.
 *
 * Por qué money-anchored: la conversión unidad→caja por factores (factor_sale/pack_size/
 * box_size/c84) es frágil — esos campos significan cosas distintas por producto (a veces
 * piezas/caja, a veces paquetes/caja) y la venta llega en unidades mixtas (PZA/PAQ/CJA).
 * El precio de la CJA es la ÚNICA referencia consistente del propio ERP: `cajas = revenue /
 * precio_CJA`. Inmune a que "pieza" sea bolsa/tira/individual. Para mayoreo (a precio CJA) es
 * exacto; para retail (con markup) es una aproximación por valor (~±markup), nunca el error
 * 12-30× de dividir por el factor equivocado.
 *
 * Sin RLS (schema analytics) → filtro tenant_id explícito en los consumidores. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('product_box_price')) return;
  await knex.raw(`
    CREATE TABLE analytics.product_box_price (
      tenant_id   uuid NOT NULL,
      product_id  uuid NOT NULL,
      cja_price   numeric NOT NULL,
      source      text NOT NULL DEFAULT 'kepler_kdpv',
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id)
    )`);
  await knex.raw(`GRANT SELECT ON analytics.product_box_price TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('product_box_price');
};
