/**
 * Sprint catálogo — Refactor `public.products_top_sellers`.
 *
 * La MV original (migración 20260602160000) usaba `commercial.order_lines` con
 * status='fulfilled'. Problema: Mega Dulces recién empezó beta el 2026-05-26,
 * solo hay 191 órdenes fulfilled tocando 7-8 productos distintos. La MV no
 * representaba el ranking real del catálogo activo.
 *
 * Fix: usar `analytics_external.ranking_legacy` (FDW al ERP Mega_Dulces) que
 * mantiene un top 1000 pre-calculado con ventas reales del ERP (~2.1M filas
 * históricas). Match por SKU (`p.sku = rl.articulo`).
 *
 * Estructura final:
 *   - Source: public.products_active (9,797 productos comerciales)
 *   - JOIN: analytics_external.ranking_legacy (1,000 top sellers del ERP)
 *   - LIMIT 1000 implícito (la foreign table ya viene con 1000)
 *
 * MV refresh: cada 15 min via AnalyticsRefreshService. El ERP actualiza su
 * `ranking_productos` con su propia cadencia, nuestra MV refleja eso.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
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
      rl.total_piezas        AS units_sold,
      rl.total_venta         AS revenue,
      rl.total_cajas         AS cases_sold,
      rl.total_piezas_totales AS units_total,
      rl.posicion            AS sales_rank
    FROM public.products_active p
    INNER JOIN analytics_external.ranking_legacy rl
      ON rl.articulo = p.sku
    ORDER BY rl.posicion ASC
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_top_sellers_pk
      ON public.products_top_sellers (tenant_id, id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_top_sellers_rank
      ON public.products_top_sellers (tenant_id, sales_rank)
  `);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW public.products_top_sellers IS 'Top 1000 productos según el ERP Mega_Dulces.ranking_productos (FDW analytics_external.ranking_legacy). Match por SKU. Refresh @15min via AnalyticsRefreshService. Reemplaza la versión 20260602160000 que usaba commercial.order_lines (sin volumen real beta).'`);
  await knex.raw(`GRANT SELECT ON public.products_top_sellers TO app_runtime`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS public.products_top_sellers`);

  // Restore versión previa (commercial.order_lines)
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
      ROW_NUMBER() OVER (PARTITION BY p.tenant_id ORDER BY totals.units_sold DESC, totals.revenue DESC) AS sales_rank
    FROM public.products p
    INNER JOIN (
      SELECT ol.product_id, ol.tenant_id,
             SUM(ol.quantity::numeric) AS units_sold,
             SUM(ol.line_total::numeric) AS revenue,
             COUNT(*) AS line_count,
             MAX(o.confirmed_at) AS last_sold_at
      FROM commercial.order_lines ol
      INNER JOIN commercial.orders o ON o.id = ol.order_id AND o.tenant_id = ol.tenant_id
      WHERE o.status = 'fulfilled' AND o.confirmed_at >= NOW() - INTERVAL '90 days'
      GROUP BY ol.product_id, ol.tenant_id
    ) totals ON totals.product_id = p.id AND totals.tenant_id = p.tenant_id
    WHERE p.deleted_at IS NULL
    ORDER BY totals.units_sold DESC
    LIMIT 1000
  `);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS products_top_sellers_pk ON public.products_top_sellers (tenant_id, id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_products_top_sellers_rank ON public.products_top_sellers (tenant_id, sales_rank)`);
  await knex.raw(`GRANT SELECT ON public.products_top_sellers TO app_runtime`);
};
