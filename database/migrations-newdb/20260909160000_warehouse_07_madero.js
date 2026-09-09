/**
 * Warehouse `07` (Morelia Madero — POS Kepler `md_07`). Cutover E, 2026-09-08.
 *
 * Madero migró su POS de Wincaja ('32') a Kepler propio (`md_07`) el 2026-09-08 (handoff limpio:
 * Wincaja 32 cerró caja el 09-07, Kepler arrancó el 09-08, cero traslape). `import-sales-fact`
 * resuelve `almacen → warehouse` por **`code`** (whTo = Map(code→id)), y `kepler-branches.js` ya
 * expone la rama `07` → su venta necesita un warehouse `code='07'` o queda sin resolver (wid undefined)
 * y se DESCARTA en silencio. Espeja a Canindo ('06'): cada sucursal Kepler tiene su warehouse numérico.
 *
 * A diferencia de Canindo (que NO tenía warehouse Wincaja previo, por eso '06' cargó `wincaja_source_branch='50'`),
 * Madero YA tiene `MD-32` con `wincaja_source_branch='32'` → ese warehouse conserva la identidad Wincaja
 * (historia < 09-08). El nuevo '07' toma SÓLO la identidad Kepler (≥ 09-08). Cada era, su casa: no se
 * duplica `wincaja_source_branch` (evita ambigüedad en scope/receipts, que sí lo leen). zone_id y
 * source_warehouse_id se derivan de MD-32 (misma plaza física, misma red de resurtido) para portabilidad
 * entre entornos. Idempotente. @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(
    `INSERT INTO commercial.warehouses
       (tenant_id, code, name, kepler_code, kind, is_default, active, sells_to_public, zone_id, source_warehouse_id, display_order, short_label)
     SELECT tenant_id, '07', 'Morelia Madero', '07', 'central', false, true, true,
            zone_id, source_warehouse_id, 8, 'MM'
       FROM commercial.warehouses
      WHERE tenant_id = ? AND code = 'MD-32'
     ON CONFLICT (tenant_id, code) DO UPDATE
       SET kepler_code = EXCLUDED.kepler_code, active = true, deleted_at = NULL, updated_at = now()`,
    [M]);
};

exports.down = async function (knex) {
  // Reversible sin borrar historia: si '07' no llegó a tener venta propia, se soft-deletea.
  await knex.raw(
    `UPDATE commercial.warehouses SET deleted_at = now()
      WHERE tenant_id = ? AND code = '07'
        AND NOT EXISTS (SELECT 1 FROM analytics.sales_daily s
                         WHERE s.warehouse_id = commercial.warehouses.id)`,
    [M]);
};
