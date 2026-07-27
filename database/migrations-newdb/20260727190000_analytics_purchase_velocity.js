/**
 * RA-PRO.17 — Velocidad de COMPRA real por producto×almacén → analytics.purchase_velocity.
 *
 * Ancla el sugerido de reabasto en el LEDGER de compras reales (entrada X-A-40 de Kepler)
 * en vez de derivarlo de demanda×política×costo — que en el granel se rompía por unidades
 * mezcladas (venta en piezas, compra en cajas, costo per-caja/per-pieza según el producto).
 * El ledger es la ÚNICA fuente auto-consistente y en dinero real: refleja lo que de verdad
 * se paga, en la unidad y costo nativos de Kepler. Validado: a 30d cobertura reproduce el
 * gasto mensual real por proveedor (Fabricas Selectas $206k ≈ $220k real). Ver FASE_RA.
 *
 *   daily_rate     = Σ qty (entrada X-A-40, ventana 90d) / 90   [unidad de COMPRA de Kepler]
 *   real_unit_cost = Σ amount / Σ qty                           [costo real por unidad de compra]
 *
 * La alimenta `import-purchase-velocity.js`. Grano = almacén×producto: SOLO los almacenes que
 * COMPRAN directo (CEDIS/hubs) tienen filas → el sugerido a proveedor se genera donde de verdad
 * se compra; las sucursales sin compra directa se surten por traspaso (no aparecen aquí).
 *
 * El sugerido = max(0, daily_rate × cobertura_días − existencia_en_unidad_de_compra) × real_unit_cost.
 *
 * analytics.* = SIN RLS → filtro tenant_id EXPLÍCITO en cada query. Aditiva, idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('purchase_velocity')) return;
  await knex.raw(`
    CREATE TABLE analytics.purchase_velocity (
      tenant_id       uuid NOT NULL,
      warehouse_id    uuid NOT NULL,       -- commercial.warehouses.id (almacén que compra directo)
      product_id      uuid NOT NULL,       -- catalog.products.id
      daily_rate      numeric NOT NULL DEFAULT 0,  -- unidades de COMPRA/día (entrada X-A-40, 90d)
      qty_90d         numeric NOT NULL DEFAULT 0,  -- Σ qty comprada en la ventana (trazabilidad)
      real_unit_cost  numeric NOT NULL DEFAULT 0,  -- Σ amount / Σ qty (costo real por unidad de compra)
      order_days      integer NOT NULL DEFAULT 0,  -- nº de días con compra en la ventana (frecuencia)
      last_purchase   date,                        -- última compra directa a proveedor
      computed_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, warehouse_id, product_id)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_purchase_velocity_wh ON analytics.purchase_velocity (tenant_id, warehouse_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_purchase_velocity_prod ON analytics.purchase_velocity (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.purchase_velocity TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('purchase_velocity');
};
