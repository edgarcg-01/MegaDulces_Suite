/**
 * is_promo — marcador de SKU promocional de Kepler (regalo/combo con precio
 * simbólico $0.01, ej. "$299 = GRATIS 1 CACAHUATE"). No es venta real: solo
 * registra la aplicación de la promo en el ticket. Los reportes por unidades
 * (sell-out, top products, best-sellers portal) lo excluyen.
 *
 * Regla determinista (la mantiene import-prices-bulk.js en cada corrida):
 *   is_promo = precio máximo vigente en product_prices <= $0.05
 * Backfill extra one-time: precio unitario implícito en la venta (revenue/units
 * 180d) <= $0.05 — cubre promos sin fila de precio.
 */
const PROMO_PRICE_MAX = 0.05;

exports.up = async function up(knex) {
  const has = await knex.schema.withSchema('catalog').hasColumn('products', 'is_promo');
  if (!has) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.boolean('is_promo').notNullable().defaultTo(false);
    });
  }

  await knex.raw(
    `UPDATE catalog.products p SET is_promo = true
      FROM (SELECT product_id, tenant_id FROM commercial.product_prices
             WHERE deleted_at IS NULL GROUP BY product_id, tenant_id
            HAVING max(price) <= ?) px
     WHERE p.id = px.product_id AND p.tenant_id = px.tenant_id AND NOT p.is_promo`,
    [PROMO_PRICE_MAX],
  );

  const hasSales = (await knex.raw(`SELECT to_regclass('analytics.sales_daily') AS r`)).rows[0].r;
  if (hasSales) {
    await knex.raw(
      `UPDATE catalog.products p SET is_promo = true
        FROM (SELECT product_id, tenant_id FROM analytics.sales_daily
               WHERE sale_date >= current_date - 180 GROUP BY product_id, tenant_id
              HAVING sum(units) >= 5 AND sum(revenue) / NULLIF(sum(units), 0) <= ?) sd
       WHERE p.id = sd.product_id AND p.tenant_id = sd.tenant_id AND NOT p.is_promo`,
      [PROMO_PRICE_MAX],
    );
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.withSchema('catalog').hasColumn('products', 'is_promo');
  if (has) await knex.schema.withSchema('catalog').alterTable('products', (t) => t.dropColumn('is_promo'));
};
