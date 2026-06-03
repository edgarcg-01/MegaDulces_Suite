/**
 * HOTFIX prod — `public.products_top_sellers` resiliente al FDW caído.
 *
 * La migración previa (`20260603100000_refactor_products_top_sellers_from_ranking_legacy.js`)
 * creaba la MV con `WITH DATA` (default), lo que dispara el SELECT joineando
 * con `analytics_external.ranking_legacy` (FDW → `192.168.0.245:5432`).
 *
 * En Railway no hay conectividad a la red local del dev → el `CREATE MATERIALIZED
 * VIEW ... WITH DATA` falla al boot → knex aborta migraciones → container API
 * no arranca → restart loop → 502 en TODOS los endpoints.
 *
 * Fix: recrear la MV `WITH NO DATA`. Queda creada/registrada pero vacía. El
 * `AnalyticsRefreshService` corre cada 15 min y poblará cuando el FDW esté
 * accesible (dev local con .245 al aire); en Railway sin FDW, el refresh
 * sigue siendo idempotente (capture el error del FDW y skip esa MV, ver
 * analytics-refresh.service.ts línea 92-95).
 *
 * Idempotente: DROP IF EXISTS al principio. Safe si ya estaba aplicada.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS public.products_top_sellers`);

  // WITH NO DATA: crea la estructura sin ejecutar el SELECT. El refresh
  // posterior lo poblará (CONCURRENTLY tras la primera población, ver
  // AnalyticsRefreshService.refreshAll).
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
    WITH NO DATA
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_top_sellers_pk
      ON public.products_top_sellers (tenant_id, id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_top_sellers_rank
      ON public.products_top_sellers (tenant_id, sales_rank)
  `);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW public.products_top_sellers IS 'Top 1000 productos según el ERP Mega_Dulces.ranking_productos (FDW analytics_external.ranking_legacy). Match por SKU. Creada WITH NO DATA — el refresh inicial la puebla cuando el FDW está accesible. En entornos sin acceso al FDW (Railway prod hoy), la MV queda vacía y el endpoint que la consulta debe tolerarlo.'`);
  await knex.raw(`GRANT SELECT ON public.products_top_sellers TO app_runtime`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // No revertimos al estado previo porque ese era el problema. Si hace falta
  // restaurar la versión `commercial.order_lines`, usar la down de la
  // migración 20260603100000.
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS public.products_top_sellers`);
};
