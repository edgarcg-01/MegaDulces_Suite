/**
 * RS.9 — `analytics.sales_by_vendor_monthly`: rollup mensual de la venta WINCAJA
 * abierta POR VENDEDOR (producto × almacén × canal × vendedor × mes). Materializa lo
 * que el sell-out calculaba al vuelo desde `wincaja.v_sales_lines` (view cara: ~10s/mes
 * por el LATERAL caja_channels + anti-join clientes + CTE conc_dates → los endpoints
 * mode=canal / by-vendor / vendors daban 504). Con el rollup el read baja a ~ms.
 *
 *   · units      = canónico (piezas: CJA×factor_venta, PZA×1 · peso: kg)
 *   · unit_kind  = 'piece' | 'weight' (KGS)
 *   · sale_channel = crudo del silver (mayoreo_credito / ruta_venta / preventa_vecinal / mostrador)
 *   · vendor_code  = source_branch:vendedor (los códigos se reusan entre plazas)
 *   · warehouse_id = ya mapeado (10→01, 42→02, resto igual) — mismo criterio que el service
 *
 * Lo alimenta el feed on-prem `import-sales-by-vendor-monthly.js` (por LOTES mensuales:
 * DELETE+INSERT por mes → transacciones chicas, sin riesgo de OOM en la DB managed).
 * Aditiva, idempotente. analytics.* no tiene RLS → filtro tenant explícito.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('sales_by_vendor_monthly'))) {
    await knex.raw(`
      CREATE TABLE analytics.sales_by_vendor_monthly (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        product_id    uuid NOT NULL,
        warehouse_id  uuid NOT NULL,
        sale_channel  text NOT NULL,               -- crudo: mayoreo_credito / ruta_venta / preventa_vecinal / mostrador
        vendor_code   text NOT NULL,               -- source_branch:vendedor
        vendor_name   text,
        year_month    text NOT NULL,               -- 'YYYY-MM'
        unit_kind     text,                          -- 'piece' | 'weight'
        units         numeric NOT NULL DEFAULT 0,    -- canónico (piezas o kg)
        revenue       numeric NOT NULL DEFAULT 0,
        tickets       integer NOT NULL DEFAULT 0,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sales_by_vendor_monthly_kind_check CHECK (unit_kind IS NULL OR unit_kind IN ('piece','weight'))
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_by_vendor_monthly
    ON analytics.sales_by_vendor_monthly (tenant_id, product_id, warehouse_id, sale_channel, vendor_code, year_month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sbv_monthly_month ON analytics.sales_by_vendor_monthly (tenant_id, year_month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sbv_monthly_channel ON analytics.sales_by_vendor_monthly (tenant_id, sale_channel, year_month)`);
  await knex.raw(`GRANT SELECT ON analytics.sales_by_vendor_monthly TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('sales_by_vendor_monthly');
};
