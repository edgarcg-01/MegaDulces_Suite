/**
 * Sprint promo engine real: campos estructurados para exponer la promo
 * aplicada en cada line + el descuento basket-level en el header del order.
 *
 * Antes vivía como prefijo de `order_lines.notes` ("Promo aplicada: <CODE>"),
 * lo cual rompía: (1) UX — el cliente no veía cuánto ahorra, (2) API consumers
 * no podían filtrar / agregar por promo, (3) `notes` se sobreescribía.
 *
 * Diseño:
 *   - order_lines.applied_promo_code  → code de la promo (FK suave a code).
 *   - order_lines.applied_promo_type  → snapshot del tipo (para auditoría).
 *   - order_lines.discount_amount     → MXN ahorrado por la promo en esta line.
 *   - orders.basket_promo_code        → code del percent_off_basket aplicado.
 *   - orders.basket_discount_amount   → MXN ahorrado por el basket promo.
 *
 * Idempotente. Down: drop columns.
 */
exports.up = async function (knex) {
  const hasAppliedCode = await knex.schema.withSchema('commercial').hasColumn('order_lines', 'applied_promo_code');
  if (!hasAppliedCode) {
    await knex.schema.withSchema('commercial').alterTable('order_lines', (table) => {
      table.text('applied_promo_code');
      table.text('applied_promo_type');
      table.decimal('discount_amount', 12, 2).notNullable().defaultTo(0);
    });
  }

  const hasBasketCode = await knex.schema.withSchema('commercial').hasColumn('orders', 'basket_promo_code');
  if (!hasBasketCode) {
    await knex.schema.withSchema('commercial').alterTable('orders', (table) => {
      table.text('basket_promo_code');
      table.decimal('basket_discount_amount', 12, 2).notNullable().defaultTo(0);
    });
  }

  await knex.raw(`
    COMMENT ON COLUMN commercial.order_lines.applied_promo_code IS
      'Code de la promo aplicada a esta line (NULL si no hay promo). Snapshot al momento del recalc — no es FK porque la promo puede borrarse después.';
  `);
  await knex.raw(`
    COMMENT ON COLUMN commercial.order_lines.applied_promo_type IS
      'Tipo de promo aplicada (nxm, percent_off_product, etc). Snapshot para auditoría.';
  `);
  await knex.raw(`
    COMMENT ON COLUMN commercial.order_lines.discount_amount IS
      'MXN ahorrado por la promo en esta line. = qty * unit_price * (1 - manual_discount) - line_subtotal.';
  `);
  await knex.raw(`
    COMMENT ON COLUMN commercial.orders.basket_promo_code IS
      'Code del percent_off_basket aplicado al total. NULL si no hubo promo basket-level.';
  `);
  await knex.raw(`
    COMMENT ON COLUMN commercial.orders.basket_discount_amount IS
      'MXN ahorrado por el percent_off_basket aplicado. 0 si no aplicó.';
  `);
};

exports.down = async function (knex) {
  const hasAppliedCode = await knex.schema.withSchema('commercial').hasColumn('order_lines', 'applied_promo_code');
  if (hasAppliedCode) {
    await knex.schema.withSchema('commercial').alterTable('order_lines', (table) => {
      table.dropColumn('applied_promo_code');
      table.dropColumn('applied_promo_type');
      table.dropColumn('discount_amount');
    });
  }
  const hasBasketCode = await knex.schema.withSchema('commercial').hasColumn('orders', 'basket_promo_code');
  if (hasBasketCode) {
    await knex.schema.withSchema('commercial').alterTable('orders', (table) => {
      table.dropColumn('basket_promo_code');
      table.dropColumn('basket_discount_amount');
    });
  }
};
