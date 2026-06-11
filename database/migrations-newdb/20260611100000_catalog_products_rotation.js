/**
 * Take-order — margen + rotación desde el ERP Mega_Dulces.productos_activos.
 *
 * `catalog.products` ya tiene cost_with_tax / cost_base / cost_per_case (vacías
 * en prod). Acá agregamos las 2 columnas de ROTACIÓN que faltan:
 *   - sales_units_30d  INTEGER       unidades vendidas últimos 30d (ERP: sum almXX_actual_30_r)
 *   - rotation_tier    VARCHAR(10)    'alta' | 'media' | 'baja' (derivada por percentil en el sync)
 *
 * El sync (`database/scripts/sync-erp-product-costs.js`) puebla cost_with_tax,
 * cost_per_case y estas dos columnas desde `erp.productos_activos` (FDW), match
 * por SKU. El endpoint de precios las expone SOLO en take-order (costo gateado
 * para customer_b2b — ver commercial-pricing.service).
 *
 * Idempotente (hasColumn). No toca la vista curada public.products (el take-order
 * lee de catalog.products calificado).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasUnits = await knex.schema.withSchema('catalog').hasColumn('products', 'sales_units_30d');
  if (!hasUnits) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.integer('sales_units_30d');
      t.string('rotation_tier', 10);
    });
  }
  await knex.raw(`COMMENT ON COLUMN catalog.products.sales_units_30d IS 'Unidades vendidas últimos 30d (ERP productos_activos: sum almXX_actual_30_r). Poblado por sync-erp-product-costs.js.'`);
  await knex.raw(`COMMENT ON COLUMN catalog.products.rotation_tier IS 'Rotación: alta (>= p75 de sales_units_30d) | media | baja (0 ventas). Derivada en el sync.'`);
};

exports.down = async function (knex) {
  const hasUnits = await knex.schema.withSchema('catalog').hasColumn('products', 'sales_units_30d');
  if (hasUnits) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.dropColumn('sales_units_30d');
      t.dropColumn('rotation_tier');
    });
  }
};
