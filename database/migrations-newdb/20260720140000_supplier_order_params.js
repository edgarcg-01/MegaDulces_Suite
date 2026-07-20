/**
 * RA-PRO.10 — Parámetros de pedido por proveedor (override manual del ciclo + mínimo de compra).
 * Sobre catalog.suppliers (junto a lead_time_days + min_order_boxes ya existentes):
 *   cadence_days_override = ciclo de PEDIDO manual (días). Si está, el motor lo usa en vez de
 *                           la cadencia derivada (solo canales de COMPRA; el traspaso mantiene la suya).
 *   colchon_days          = colchón/buffer en días de demanda. Con override: horizonte = cadencia + colchón.
 *   min_order_amount       = mínimo de compra en $ (el mínimo en cajas ya es min_order_boxes).
 * El motor evalúa el mínimo POR PROVEEDOR (total de sus almacenes) y sube el pedido al mínimo
 * repartiendo el faltante en los SKUs que más rotan (ver commercial-replenishment.service).
 * Idempotente (hasColumn).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const add = async (col, ddl, comment) => {
    if (!(await knex.schema.withSchema('catalog').hasColumn('suppliers', col))) {
      await knex.raw(`ALTER TABLE catalog.suppliers ADD COLUMN ${col} ${ddl}`);
      if (comment) await knex.raw(`COMMENT ON COLUMN catalog.suppliers.${col} IS '${comment}'`);
    }
  };
  await add('cadence_days_override', 'integer', 'RA-PRO.10 — ciclo de pedido manual (días). Override de la cadencia derivada (solo compra).');
  await add('colchon_days', 'integer', 'RA-PRO.10 — colchón en días de demanda. Con override: horizonte = cadencia + colchón.');
  await add('min_order_amount', 'numeric(14,2)', 'RA-PRO.10 — mínimo de compra en $ (complementa min_order_boxes en cajas).');
};

exports.down = async function (knex) {
  for (const col of ['cadence_days_override', 'colchon_days', 'min_order_amount']) {
    if (await knex.schema.withSchema('catalog').hasColumn('suppliers', col)) {
      await knex.raw(`ALTER TABLE catalog.suppliers DROP COLUMN ${col}`);
    }
  }
};
