/**
 * W.5 (gold) - Alta del almacen MD-32 (Morelia Madero), que faltaba.
 *
 * MD-30 (Morelia Abastos) y MD-50 (Canindo) ya existen en commercial.warehouses;
 * MD-32 no. Se necesita para poder mapear la venta de la sucursal 32 (Wincaja)
 * al warehouse_id que consume analytics.sales_daily (feed import-wincaja-analytics).
 *
 * Idempotente (WHERE NOT EXISTS). tenant_id explicito (mega_dulces).
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(
    `INSERT INTO commercial.warehouses (tenant_id, code, name, kind, active)
     SELECT ?, 'MD-32', 'Almacén Morelia Madero (32)', 'central', true
     WHERE NOT EXISTS (
       SELECT 1 FROM commercial.warehouses WHERE tenant_id = ? AND code = 'MD-32'
     )`,
    [TENANT, TENANT],
  );
};

exports.down = async function (knex) {
  // no-op: no se borra el almacen (puede tener datos dependientes)
};
