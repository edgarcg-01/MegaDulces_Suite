/**
 * W.5 (gold) - Alta de los almacenes MD-30 (Morelia Abastos) y MD-50 (Canindo).
 *
 * La migracion 20260713160000 asumio que ya existian, pero en prod NO estaban:
 * solo se habia creado MD-32. Sin estos, el feed import-wincaja-analytics/-stock
 * no puede mapear la venta/existencia de las sucursales 30 y 50 (Wincaja-only,
 * invisibles en Kepler) al warehouse_id -> se caian de analytics.sales_daily y
 * commercial.stock. Idempotente (WHERE NOT EXISTS). tenant_id explicito.
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

const WAREHOUSES = [
  ['MD-30', 'Almacén Morelia Abastos (30)'],
  ['MD-50', 'Almacén Canindo (50)'],
];

exports.up = async function (knex) {
  for (const [code, name] of WAREHOUSES) {
    await knex.raw(
      `INSERT INTO commercial.warehouses (tenant_id, code, name, kind, active)
       SELECT ?, ?, ?, 'central', true
       WHERE NOT EXISTS (
         SELECT 1 FROM commercial.warehouses WHERE tenant_id = ? AND code = ?
       )`,
      [TENANT, code, name, TENANT, code],
    );
  }
};

exports.down = async function () {
  // no-op: no se borra el almacen (puede tener datos dependientes)
};
