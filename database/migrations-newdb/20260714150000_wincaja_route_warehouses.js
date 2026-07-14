/**
 * W.10 - Unidades gold para rutas: cada ruta = su propio warehouse (kind='truck').
 *
 * Regla (Edgar): la venta a bordo se atribuye a la RUTA como unidad propia. Para que
 * fluya al gold (analytics.sales_daily) se le da un warehouse `RUTA-<code>` y se setea
 * branches.warehouse_code. El feed de venta la manda con channel='wincaja_ruta'
 * (separable). El feed de stock EXCLUYE RUTA-% (no metemos inventario de camion en
 * la existencia de almacenes).
 *
 * Idempotente. tenant_id explicito (corre como postgres, bypassa RLS).
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  // 1. Un warehouse por ruta (kind='truck'). Se derivan de las rutas ya sembradas.
  await knex.raw(
    `INSERT INTO commercial.warehouses (tenant_id, code, name, kind, active)
     SELECT b.tenant_id, 'RUTA-' || b.source_branch, 'Ruta ' || b.source_branch, 'truck', true
     FROM wincaja.branches b
     WHERE b.tenant_id = ? AND b.is_route
       AND NOT EXISTS (
         SELECT 1 FROM commercial.warehouses w
         WHERE w.tenant_id = b.tenant_id AND w.code = 'RUTA-' || b.source_branch
       )`,
    [TENANT],
  );

  // 2. Ligar cada ruta a su warehouse (para que silver/gold la mapeen).
  await knex.raw(
    `UPDATE wincaja.branches
     SET warehouse_code = 'RUTA-' || source_branch
     WHERE tenant_id = ? AND is_route AND warehouse_code IS DISTINCT FROM 'RUTA-' || source_branch`,
    [TENANT],
  );
};

exports.down = async function (knex) {
  await knex.raw(`UPDATE wincaja.branches SET warehouse_code = NULL WHERE tenant_id = ? AND is_route`, [TENANT]);
  // Los warehouses RUTA-* se dejan (pueden tener stock/analytics dependientes).
};
