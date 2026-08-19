/**
 * Normalización (mandato "todo con FK o vista") — FK `product_id → catalog.products(id)` en las
 * tablas copia de `analytics.*`.
 *
 * Análisis (2026-08-19): 20 tablas cargan `product_id` uuid. La dim canónica es `catalog.products(id)`
 * (14,711 filas, PK uuid). Seguridad verificada:
 *   - `catalog.products` es SOFT-DELETE (deleted_at) → los ids referenciados nunca desaparecen →
 *     la FK jamás bloquea por borrado del padre.
 *   - Los importers resuelven product_id vía sku→id contra el catálogo (skuTo) y las columnas son
 *     NOT NULL → todo insert nuevo referencia un id vigente → no genera huérfanos.
 *   - Orphan check: 19 tablas con 0 huérfanos; `product_sales_daily` con 6 legacy (productos
 *     hard-borrados hace tiempo, previo al soft-delete).
 *
 * → 19 tablas con FK VALIDADA; `product_sales_daily` con FK `NOT VALID` (declara + enforcea inserts
 * nuevos; tolera los 6 legacy hasta limpiarlos). Idempotente. product_sales_daily.product_id es
 * NOT NULL, por eso no se pueden NULL-ear los 6 → NOT VALID es la vía sin borrar datos.
 *
 * @param { import("knex").Knex } knex
 */
const VALIDATED = [
  'customer_product_sales', 'demand_acceleration', 'erp_promotions', 'erp_shipments', 'inventory_health',
  'product_box_factor', 'product_box_price', 'product_demand', 'product_sales_monthly', 'product_sales_stats',
  'purchase_in_transit', 'purchase_velocity', 'replenishment_plan', 'sales_boxes_monthly', 'sales_by_vendor_monthly',
  'sales_daily', 'sales_monthly', 'stock_movements', 'wincaja_product_box_factor',
];
const NOT_VALID = ['product_sales_daily']; // 6 huérfanos legacy → declarar sin validar
const fkName = (t) => `fk_${t}_product`;
// supplier_id → catalog.suppliers(id) — 1 tabla, 0 huérfanos verificado.
const SUPPLIER = ['replenishment_plan'];
const supFk = (t) => `fk_${t}_supplier`;

async function addFk(knex, t, col, ref, name, validate) {
  const exists = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname=? AND conrelid=to_regclass(?)`, [name, `analytics.${t}`]);
  if (exists.rows.length) return;
  await knex.raw(`ALTER TABLE analytics.${t} ADD CONSTRAINT ${name} FOREIGN KEY (${col}) REFERENCES ${ref} NOT VALID`);
  if (validate) await knex.raw(`ALTER TABLE analytics.${t} VALIDATE CONSTRAINT ${name}`);
}

exports.up = async function (knex) {
  for (const t of VALIDATED) await addFk(knex, t, 'product_id', 'catalog.products(id)', fkName(t), true);
  for (const t of NOT_VALID) await addFk(knex, t, 'product_id', 'catalog.products(id)', fkName(t), false);
  for (const t of SUPPLIER) await addFk(knex, t, 'supplier_id', 'catalog.suppliers(id)', supFk(t), true);
};

exports.down = async function (knex) {
  for (const t of [...VALIDATED, ...NOT_VALID]) {
    await knex.raw(`ALTER TABLE analytics.${t} DROP CONSTRAINT IF EXISTS ${fkName(t)}`);
  }
  for (const t of SUPPLIER) await knex.raw(`ALTER TABLE analytics.${t} DROP CONSTRAINT IF EXISTS ${supFk(t)}`);
};
