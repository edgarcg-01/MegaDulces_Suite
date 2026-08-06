/**
 * Factor de caja de WINCAJA por producto (factor_venta = unidades/caja que agrupa Wincaja).
 *
 * Motivo: la existencia de los almacenes ciegos (MD-30/32/50) se guarda en la unidad de
 * Wincaja (paquetes para multi-pack), no en piezas como Kepler. Para MOSTRAR cajas correctas
 * el display de /compras divide la existencia por ESTE factor en almacenes Wincaja
 * (en Kepler sigue usando el resolver canónico c84). No toca datos ni la economía del reorden
 * (que ya es auto-consistente en la unidad cruda de cada almacén); es solo capa de presentación.
 *
 * Verificado con 3 testigos (precio de venta + costo de existencia + factor_venta nativo):
 * factor_venta reproduce exacto las cajas físicas para el set multi-pack. Ver análisis en sesión.
 *
 * La pobla `database/importers/wincaja/import-wincaja-caja-factor.js` (idempotente, nightly).
 */
'use strict';

exports.up = async function up(knex) {
  const has = await knex.schema.withSchema('analytics').hasTable('wincaja_product_box_factor');
  if (!has) {
    await knex.schema.withSchema('analytics').createTable('wincaja_product_box_factor', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('product_id').notNullable();
      t.decimal('factor_venta', 12, 3).notNullable(); // unidades de venta de Wincaja por caja
      t.timestamp('computed_at', { useTz: true }).defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'product_id']);
    });
  }
  await knex.raw('GRANT SELECT ON analytics.wincaja_product_box_factor TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('wincaja_product_box_factor');
};
