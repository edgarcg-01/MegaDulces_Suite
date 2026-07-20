/**
 * Sell-Out RS.3 — `analytics.sales_daily.unit_kind` ('piece' | 'weight').
 *
 * Problema: el feed sumaba `cantidad` mezclando unidades de venta heterogéneas
 * (paquetes + piezas + kg + porciones de 500 g) en un solo `units`, y el reporte
 * dividía todo por `factor_sale` etiquetándolo "cajas" → granel y bulto mostraban
 * cajas inexistentes. Ahora el feed normaliza `units` a un canónico coherente por
 * producto: PIEZAS para producto de pieza, KG para producto de peso/granel. Este
 * flag le dice al reporte cómo interpretar/etiquetar la cantidad (÷factor→cajas vs
 * mostrar kg). Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasColumn('sales_daily', 'unit_kind');
  if (!has) {
    await knex.schema.withSchema('analytics').alterTable('sales_daily', (t) => {
      t.text('unit_kind'); // 'piece' | 'weight' (null = legacy, se trata como piece)
    });
  }
  await knex.raw(`ALTER TABLE analytics.sales_daily DROP CONSTRAINT IF EXISTS sales_daily_unit_kind_check`);
  await knex.raw(`ALTER TABLE analytics.sales_daily ADD CONSTRAINT sales_daily_unit_kind_check CHECK (unit_kind IS NULL OR unit_kind IN ('piece','weight'))`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.sales_daily DROP CONSTRAINT IF EXISTS sales_daily_unit_kind_check`);
  const has = await knex.schema.withSchema('analytics').hasColumn('sales_daily', 'unit_kind');
  if (has) {
    await knex.schema.withSchema('analytics').alterTable('sales_daily', (t) => t.dropColumn('unit_kind'));
  }
};
