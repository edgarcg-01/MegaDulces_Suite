/**
 * Sprint organización catálogo — crea VIEWS sobre `public.products`:
 *
 *   1. `public.products_active`        — VIEW virtual (siempre fresca)
 *      Productos comerciales no eliminados. Lo que el portal/vendor muestran
 *      por default. ~9,797 rows hoy.
 *
 *   2. `public.products_top_sellers`   — MATERIALIZED VIEW
 *      Top 1000 productos por unidades vendidas en los últimos 90 días
 *      (orders.status = 'fulfilled'). Hoy con poco volumen (~8 rows) pero
 *      crece orgánicamente con ventas reales. Refrescada nightly via cron.
 *
 * Patrón: una sola fuente de verdad (`public.products`), VIEWS para distintos
 * recortes lógicos. Cero duplicación de data. Las VIEWS se actualizan solas
 * cuando cambia `products` (la MV con refresh explícito por performance).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS public.products_active`);
  await knex.raw(`
    CREATE VIEW public.products_active AS
    SELECT p.*
    FROM public.products p
    LEFT JOIN public.brands b
      ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    WHERE p.deleted_at IS NULL
      AND COALESCE(b.is_commercial, true) = true
  `);
  await knex.raw(`COMMENT ON VIEW public.products_active IS 'Productos comerciales no eliminados (filtro: deleted_at NULL + brand.is_commercial). Fuente para portal/vendor. Siempre fresca — no requiere refresh.'`);
  await knex.raw(`GRANT SELECT ON public.products_active TO app_runtime`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS public.products_top_sellers`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW public.products_top_sellers AS
    SELECT
      p.id,
      p.tenant_id,
      p.sku,
      p.nombre,
      p.brand_id,
      p.barcode,
      p.category_id,
      p.cost_base,
      p.image_url,
      totals.units_sold,
      totals.revenue,
      totals.line_count,
      totals.last_sold_at,
      ROW_NUMBER() OVER (
        PARTITION BY p.tenant_id
        ORDER BY totals.units_sold DESC, totals.revenue DESC
      ) AS sales_rank
    FROM public.products p
    INNER JOIN (
      SELECT
        ol.product_id,
        ol.tenant_id,
        SUM(ol.quantity::numeric) AS units_sold,
        SUM(ol.line_total::numeric) AS revenue,
        COUNT(*) AS line_count,
        MAX(o.confirmed_at) AS last_sold_at
      FROM commercial.order_lines ol
      INNER JOIN commercial.orders o
        ON o.id = ol.order_id AND o.tenant_id = ol.tenant_id
      WHERE o.status = 'fulfilled'
        AND o.confirmed_at >= NOW() - INTERVAL '90 days'
      GROUP BY ol.product_id, ol.tenant_id
    ) totals
      ON totals.product_id = p.id AND totals.tenant_id = p.tenant_id
    WHERE p.deleted_at IS NULL
    ORDER BY totals.units_sold DESC
    LIMIT 1000
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_top_sellers_pk
      ON public.products_top_sellers (tenant_id, id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_top_sellers_rank
      ON public.products_top_sellers (tenant_id, sales_rank)
  `);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW public.products_top_sellers IS 'Top 1000 productos por unidades vendidas últimos 90 días (orders fulfilled). Refresh nightly via AnalyticsRefreshService. Crece con volumen de ventas — hoy ~pocas rows hasta que Mega Dulces tenga volúmen real.'`);
  await knex.raw(`GRANT SELECT ON public.products_top_sellers TO app_runtime`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS public.products_top_sellers`);
  await knex.raw(`DROP VIEW IF EXISTS public.products_active`);
};
