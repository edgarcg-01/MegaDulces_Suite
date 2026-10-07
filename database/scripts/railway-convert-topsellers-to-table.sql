-- HOTFIX: convertir catalog.products_top_sellers de MV (vacía + FDW unreachable)
-- a TABLE regular, para poder INSERT data sincronizada desde local.
-- public.products_top_sellers queda como VIEW backward-compat.

BEGIN;

-- 1. Drop la VIEW pública que depende de la MV (CASCADE-safe; la recreamos abajo)
DROP VIEW IF EXISTS public.products_top_sellers;

-- 2. Drop la MV (perdemos solo la definición — estaba vacía con NO DATA)
DROP MATERIALIZED VIEW IF EXISTS catalog.products_top_sellers;

-- 3. Recrear como TABLE regular con la misma shape que la MV local
CREATE TABLE catalog.products_top_sellers (
  id          uuid,
  tenant_id   uuid,
  sku         varchar(20),
  nombre      varchar(150),
  brand_id    uuid,
  barcode     varchar(30),
  category_id uuid,
  cost_base   numeric(14,4),
  image_url   text,
  units_sold  numeric,
  revenue     numeric,
  cases_sold  bigint,
  units_total numeric,
  sales_rank  integer
);
CREATE UNIQUE INDEX products_top_sellers_pk ON catalog.products_top_sellers (tenant_id, id);
CREATE INDEX idx_products_top_sellers_rank ON catalog.products_top_sellers (tenant_id, sales_rank);
GRANT SELECT ON catalog.products_top_sellers TO app_runtime;

-- 4. Recrear VIEW backward-compat en public.*
CREATE VIEW public.products_top_sellers AS
  SELECT id, tenant_id, sku, nombre, brand_id, barcode, category_id,
         cost_base, image_url, units_sold, revenue, cases_sold,
         units_total, sales_rank
  FROM catalog.products_top_sellers;
GRANT SELECT ON public.products_top_sellers TO app_runtime;

COMMENT ON TABLE catalog.products_top_sellers IS
  'HOTFIX 2026-06-03: convertida de MV a TABLE porque la MV original dependía del FDW analytics_external.ranking_legacy que apunta a 192.168.0.245 (red local, inalcanzable desde Railway). Se rellena via sync manual desde local (donde el FDW sí está accesible). AnalyticsRefreshService debe skipear esta entrada (no es MV refresheable).';

COMMIT;
