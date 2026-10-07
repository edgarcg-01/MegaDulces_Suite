/**
 * RA.5 — OC en tránsito (compras pedidas aún no recibidas) → analytics.purchase_in_transit.
 *
 * La alimenta `import-in-transit.js`: lee las órdenes de compra de Kepler (doctype
 * X-A-35 en kdm1/kdm2) que NO tienen aún una orden de entrada (X-A-40) aguas abajo
 * vía el vale (X-A-37) — es decir, mercancía pedida al proveedor que todavía no entró
 * al inventario. Grano = almacén×producto (agregado). Ver FASE_RA §2.5.
 *
 * Uso: el reporte de Existencia Crítica resta esta cantidad del sugerido
 *   sugerido = max(0, objetivo − existencia − en_tránsito)
 * para no re-pedir lo que ya viene en camino.
 *
 * analytics.* = SIN RLS → filtro tenant_id EXPLÍCITO en cada query. Aditiva, idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('purchase_in_transit')) return;
  await knex.raw(`
    CREATE TABLE analytics.purchase_in_transit (
      tenant_id       uuid NOT NULL,
      warehouse_id    uuid NOT NULL,       -- commercial.warehouses.id (resuelto del code del importer)
      product_id      uuid NOT NULL,       -- catalog.products.id (resuelto del sku)
      qty_in_transit  numeric NOT NULL DEFAULT 0,  -- Σ líneas OC X-A-35 sin orden de entrada X-A-40
      oc_count        integer NOT NULL DEFAULT 0,  -- nº de OCs abiertas que aportan
      computed_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, warehouse_id, product_id)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_purchase_in_transit_wh ON analytics.purchase_in_transit (tenant_id, warehouse_id)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.purchase_in_transit TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('purchase_in_transit');
};
