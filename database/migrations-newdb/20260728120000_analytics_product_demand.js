/**
 * RA-PRO.17.1 — Demanda LIMPIA por almacén × producto.
 *
 * Problema: analytics.sales_daily.units está contaminado por UNIDAD DE VENTA MIXTA:
 * las tiendas de mayoreo (MD-30/32/50) venden por CAJA y las de retail/ruta (01-05)
 * por PIEZA, pero ambas quedan como unit_kind='piece' → `units` no es comparable entre
 * almacenes (factor caja≈40-260×) y además hay SKUs basura precio-$0 que inflan millones
 * de "piezas". El revenue SÍ es agnóstico a la unidad.
 *
 * Solución (feed import-demand-clean.js): precio_pieza(producto) = MIN($/u implícito
 * entre almacenes con venta) — la pieza es siempre la unidad más granular →
 * piezas_limpias(almacén) = revenue(almacén) / precio_pieza. Normaliza caja- y
 * pieza-vendedores uniformemente. Substrato de compra sugerida, ranking, sobrestock y
 * TRASPASO preciso (todos necesitan demanda por almacén confiable).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  const exists = await knex.schema.withSchema('analytics').hasTable('product_demand');
  if (!exists) {
    await knex.raw(`
      CREATE TABLE analytics.product_demand (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        warehouse_id  uuid NOT NULL,
        product_id    uuid NOT NULL,
        window_days   integer NOT NULL DEFAULT 30,
        pieces        numeric NOT NULL DEFAULT 0,   -- piezas limpias en la ventana
        revenue       numeric NOT NULL DEFAULT 0,
        daily_pieces  numeric NOT NULL DEFAULT 0,   -- pieces / window_days
        daily_revenue numeric NOT NULL DEFAULT 0,
        piece_price   numeric NOT NULL DEFAULT 0,   -- $/pieza (nivel producto; = MIN implícito)
        computed_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE UNIQUE INDEX uq_product_demand ON analytics.product_demand (tenant_id, warehouse_id, product_id, window_days)`);
    await knex.raw(`CREATE INDEX ix_product_demand_prod ON analytics.product_demand (tenant_id, product_id, window_days)`);
    await knex.raw(`COMMENT ON TABLE analytics.product_demand IS 'RA-PRO.17.1 — demanda limpia (piezas equivalentes vía revenue÷precio_pieza) por almacén×producto. Substrato de compra/traspaso/ranking.'`);
    // Sin RLS (patrón analytics.*: Postgres no soporta RLS en MVs y estos feeds filtran
    // tenant_id explícito; consistente con inventory_health / purchase_velocity).
    await knex.raw(`GRANT SELECT ON analytics.product_demand TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.product_demand`);
};
