/**
 * RA-PRO.31 — Fact precomputado del pedido (Compras) por almacén × producto.
 *
 * `/compras/pedido` recomputaba en CADA carga, ×3 endpoints en paralelo (comprar/traspaso/
 * sobrestock), las mismas CTEs pesadas: ratio de canal (scan de analytics.sales_daily 90d ~710k
 * filas, ~1.6s), demanda 30d, existencia, econ (suf/bf/uxc/costo). ~4s de scans × 3 saturaban la
 * instancia chica de Railway → 22s de wall-clock + freeze del navegador.
 *
 * Este fact materializa esas primitivas UNA VEZ (lo escribe el runner on-prem: nightly + ciclo
 * stock-live), igual que analytics.product_demand / mv_*. Los 3 endpoints pasan a LEER de aquí
 * (proyección + ventana baratas) en vez de recomputar. Grano = (tenant, warehouse, product),
 * product_id ya CANÓNICO (aliases plegados en el refresh). Sin RLS (patrón analytics.*, tenant_id
 * explícito en cada query). Refresco REPLACE por tenant. Reversible (drop table + revert endpoints).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('replenishment_plan'))) {
    await knex.raw(`
      CREATE TABLE analytics.replenishment_plan (
        tenant_id           uuid NOT NULL,
        warehouse_id        uuid NOT NULL,
        product_id          uuid NOT NULL,             -- canónico (aliases plegados)
        sku                 text,
        nombre              text,
        supplier_id         uuid,
        category_id         uuid,
        source_warehouse_id uuid,                      -- topología: CEDIS que surte a esta sucursal
        is_hub              boolean NOT NULL DEFAULT false,
        daily_pieces        numeric NOT NULL DEFAULT 0, -- demanda diaria PROPIA del almacén (piezas)
        revenue30           numeric NOT NULL DEFAULT 0, -- venta 30d $ (para ranking ABC + total revenue)
        eff_daily           numeric NOT NULL DEFAULT 0, -- demanda EFECTIVA (sucursal=propia; CEDIS=Σ hijos) para sobrestock
        stock_pz            numeric NOT NULL DEFAULT 0, -- existencia (unidades de stock)
        transit_cajas       numeric NOT NULL DEFAULT 0, -- OC en tránsito (ya en cajas)
        suf                 numeric NOT NULL DEFAULT 1, -- sub-unidades de demanda por unidad de stock
        bf                  numeric NOT NULL DEFAULT 1, -- unidades de stock por CAJA (= uxc)
        caja_cost           numeric NOT NULL DEFAULT 0, -- costo real POR CAJA (costE × bf)
        price_ratio         numeric,                   -- mayoreo/retail (diagnóstico de unidad)
        unit_source         text,                      -- manual | granel | revisar | catalog
        buy_rate            numeric,                   -- ritmo de compra real (cajas/día, purchase_velocity)
        real_buy_cost       numeric,                   -- costo por unidad de stock del ledger (fallback catálogo)
        last_purchase       timestamptz,
        order_days          int,
        primary_wh          uuid,                      -- almacén primario de compra (mayor volumen en el ledger)
        computed_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, warehouse_id, product_id)
      )`);
    await knex.raw(`CREATE INDEX ix_rplan_tenant_supplier ON analytics.replenishment_plan (tenant_id, supplier_id)`);
    await knex.raw(`CREATE INDEX ix_rplan_tenant_product  ON analytics.replenishment_plan (tenant_id, product_id)`);
    await knex.raw(`CREATE INDEX ix_rplan_tenant_source   ON analytics.replenishment_plan (tenant_id, source_warehouse_id)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.replenishment_plan TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.replenishment_plan IS 'RA-PRO.31 — fact precomputado del pedido (almacén×producto). Lo refresca el runner; los 3 endpoints leen de aquí.'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.replenishment_plan`);
};
