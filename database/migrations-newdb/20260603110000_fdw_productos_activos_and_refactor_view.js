/**
 * Sprint catálogo — Refactor `public.products_active` para usar el filtro
 * autoritativo del ERP Mega_Dulces.
 *
 * Estructura del ERP Mega_Dulces:
 *   catalogo_completo   → 13,852 SKUs (todos los productos del histórico)
 *   productos_activos   →  6,489 SKUs (lo que realmente se vende hoy)
 *   ranking_productos   →  1,000 SKUs (top vendidos)
 *
 * Mapeo a nuestras VIEWS en postgres_platform:
 *   public.products              ↔ catalogo_completo  (1228 hoy local — depende del sync)
 *   public.products_active       ↔ productos_activos  (filtro por SKU vía FDW)
 *   public.products_top_sellers  ↔ ranking_productos  (ya implementado)
 *
 * Cambios:
 *   1. Foreign table `analytics_external.productos_activos_legacy` apuntando
 *      al ERP via FDW (server `mega_dulces_srv` ya existe).
 *   2. Recrear VIEW `public.products_active` agregando INNER JOIN con
 *      productos_activos_legacy por `p.sku = pa.articulo`. Mantiene el filtro
 *      existente de `brand.is_commercial` + `deleted_at IS NULL`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1. Foreign table productos_activos
  await knex.raw(`DROP FOREIGN TABLE IF EXISTS analytics_external.productos_activos_legacy CASCADE`);
  await knex.raw(`
    CREATE FOREIGN TABLE analytics_external.productos_activos_legacy (
      articulo VARCHAR(20)
    ) SERVER mega_dulces_srv
      OPTIONS (schema_name 'public', table_name 'productos_activos')
  `);
  await knex.raw(`GRANT SELECT ON analytics_external.productos_activos_legacy TO app_runtime`);

  // 2. Recrear VIEW products_active filtrando por productos_activos del ERP.
  // Importante: DROP CASCADE no porque alguna MV (products_top_sellers) la
  // referencia. La nueva versión mantiene shape compatible.
  await knex.raw(`DROP VIEW IF EXISTS public.products_active CASCADE`);
  await knex.raw(`
    CREATE VIEW public.products_active AS
    SELECT p.*
    FROM public.products p
    INNER JOIN analytics_external.productos_activos_legacy pa
      ON pa.articulo = p.sku
    LEFT JOIN public.brands b
      ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    WHERE p.deleted_at IS NULL
      AND COALESCE(b.is_commercial, true) = true
  `);
  await knex.raw(`GRANT SELECT ON public.products_active TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW public.products_active IS 'Productos comerciales activos según ERP Mega_Dulces.productos_activos (FDW). Match por SKU. Filtros adicionales: deleted_at NULL + brand.is_commercial. Reemplaza la versión 20260602160000 que solo filtraba por brand.is_commercial.'`);

  // 3. Recrear MV products_top_sellers (drop por CASCADE arriba)
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS public.products_top_sellers`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW public.products_top_sellers AS
    SELECT
      p.id, p.tenant_id, p.sku, p.nombre, p.brand_id, p.barcode, p.category_id,
      p.cost_base, p.image_url,
      rl.total_piezas AS units_sold,
      rl.total_venta AS revenue,
      rl.total_cajas AS cases_sold,
      rl.total_piezas_totales AS units_total,
      rl.posicion AS sales_rank
    FROM public.products_active p
    INNER JOIN analytics_external.ranking_legacy rl
      ON rl.articulo = p.sku
    ORDER BY rl.posicion ASC
  `);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS products_top_sellers_pk ON public.products_top_sellers (tenant_id, id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_products_top_sellers_rank ON public.products_top_sellers (tenant_id, sales_rank)`);
  await knex.raw(`GRANT SELECT ON public.products_top_sellers TO app_runtime`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Restore version anterior (sin INNER JOIN al ERP)
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS public.products_top_sellers`);
  await knex.raw(`DROP VIEW IF EXISTS public.products_active`);
  await knex.raw(`DROP FOREIGN TABLE IF EXISTS analytics_external.productos_activos_legacy`);

  await knex.raw(`
    CREATE VIEW public.products_active AS
    SELECT p.*
    FROM public.products p
    LEFT JOIN public.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    WHERE p.deleted_at IS NULL AND COALESCE(b.is_commercial, true) = true
  `);
  await knex.raw(`GRANT SELECT ON public.products_active TO app_runtime`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW public.products_top_sellers AS
    SELECT
      p.id, p.tenant_id, p.sku, p.nombre, p.brand_id, p.barcode, p.category_id,
      p.cost_base, p.image_url,
      rl.total_piezas AS units_sold, rl.total_venta AS revenue,
      rl.total_cajas AS cases_sold, rl.total_piezas_totales AS units_total,
      rl.posicion AS sales_rank
    FROM public.products_active p
    INNER JOIN analytics_external.ranking_legacy rl ON rl.articulo = p.sku
    ORDER BY rl.posicion ASC
  `);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS products_top_sellers_pk ON public.products_top_sellers (tenant_id, id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_products_top_sellers_rank ON public.products_top_sellers (tenant_id, sales_rank)`);
  await knex.raw(`GRANT SELECT ON public.products_top_sellers TO app_runtime`);
};
