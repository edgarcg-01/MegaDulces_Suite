-- Fix: catalog.products_top_sellers en Railway tiene product_ids del LOCAL
-- (cargados en L.6 desde CSV) pero el portal queryea catalog.products de Railway
-- (con UUIDs DISTINTOS). Re-popular usando los product_ids correctos via
-- matching SKU↔COALESCE(sku, articulo).

BEGIN;

ALTER TABLE catalog.products_top_sellers DISABLE TRIGGER ALL;

-- Backup actual a temp
CREATE TEMP TABLE temp_ts ON COMMIT DROP AS
  SELECT * FROM catalog.products_top_sellers;

-- Vaciar tabla
DELETE FROM catalog.products_top_sellers;

-- Re-insertar usando product_ids de Railway via match SKU
INSERT INTO catalog.products_top_sellers
  (id, tenant_id, sku, nombre, brand_id, barcode, category_id, cost_base,
   image_url, units_sold, revenue, cases_sold, units_total, sales_rank)
SELECT DISTINCT ON (p.id)
  p.id,
  p.tenant_id,
  COALESCE(p.sku, p.articulo)              AS sku,
  COALESCE(p.nombre, t.nombre)              AS nombre,
  p.brand_id,
  p.barcode,
  p.category_id,
  COALESCE(p.cost_base, t.cost_base)        AS cost_base,
  COALESCE(p.image_url, t.image_url)        AS image_url,
  t.units_sold,
  t.revenue,
  t.cases_sold,
  t.units_total,
  t.sales_rank
FROM temp_ts t
JOIN catalog.products p
  ON COALESCE(p.sku, p.articulo) = t.sku
 AND p.tenant_id = t.tenant_id
 AND p.deleted_at IS NULL
ORDER BY p.id, t.sales_rank ASC;

ALTER TABLE catalog.products_top_sellers ENABLE TRIGGER ALL;

COMMIT;

-- Verificar
SELECT
  COUNT(*) AS rows,
  COUNT(*) FILTER (WHERE id IN (SELECT id FROM catalog.products)) AS id_in_railway
FROM catalog.products_top_sellers;
