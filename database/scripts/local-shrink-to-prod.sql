-- Alinear local con prod:
--   - catalog.products: keep solo SKUs que están en prod (886 esperados)
--   - trade.planogram_skus: keep solo SKUs que están en prod planogram (852)
-- Hace cleanup de tablas FK-related en commercial.* (orphan rows).
--
-- NO toca identity, public (trade-views), ni schemas trade fuera de planogram_skus.

BEGIN;
SET session_replication_role = 'replica';

-- Disable triggers en las tablas afectadas (FKs RESTRICT respetan triggers)
ALTER TABLE catalog.products              DISABLE TRIGGER ALL;
ALTER TABLE commercial.product_prices     DISABLE TRIGGER ALL;
ALTER TABLE commercial.stock              DISABLE TRIGGER ALL;
ALTER TABLE commercial.stock_movements    DISABLE TRIGGER ALL;
ALTER TABLE commercial.order_lines        DISABLE TRIGGER ALL;
ALTER TABLE commercial.vendor_sale_lines  DISABLE TRIGGER ALL;
ALTER TABLE trade.planogram_skus          DISABLE TRIGGER ALL;

-- ──────────────────────────────────────────────────────────────────────
-- Cargar SKUs prod en temp tables
-- ──────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE keep_catalog_skus_raw (sku varchar(20));
\COPY keep_catalog_skus_raw FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/prod-catalog-skus.csv' WITH (FORMAT csv, HEADER false)
CREATE TEMP TABLE keep_catalog_skus AS SELECT DISTINCT sku FROM keep_catalog_skus_raw;
CREATE INDEX ON keep_catalog_skus (sku);

CREATE TEMP TABLE keep_planogram_skus_raw (sku varchar(20));
\COPY keep_planogram_skus_raw FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/prod-planogram-skus.csv' WITH (FORMAT csv, HEADER false)
CREATE TEMP TABLE keep_planogram_skus AS SELECT DISTINCT sku FROM keep_planogram_skus_raw;
CREATE INDEX ON keep_planogram_skus (sku);

-- Verificación
SELECT 'keep_catalog_skus' AS t, COUNT(*) FROM keep_catalog_skus
UNION ALL SELECT 'keep_planogram_skus', COUNT(*) FROM keep_planogram_skus;

-- ──────────────────────────────────────────────────────────────────────
-- IDs locales a borrar
-- ──────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE products_to_delete AS
  SELECT id FROM catalog.products
  WHERE sku IS NULL OR sku NOT IN (SELECT sku FROM keep_catalog_skus);

SELECT 'products_to_delete' AS t, COUNT(*) FROM products_to_delete;

-- ──────────────────────────────────────────────────────────────────────
-- Cleanup commercial.* huérfanos primero (FKs RESTRICT)
-- ──────────────────────────────────────────────────────────────────────
DELETE FROM commercial.product_prices
  WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM commercial.stock
  WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM commercial.stock_movements
  WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM commercial.order_lines
  WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM commercial.vendor_sale_lines
  WHERE product_id IN (SELECT id FROM products_to_delete);

-- ──────────────────────────────────────────────────────────────────────
-- DELETE catalog.products (trade.planogram_skus cascadea automáticamente)
-- ──────────────────────────────────────────────────────────────────────
DELETE FROM catalog.products WHERE id IN (SELECT id FROM products_to_delete);

-- ──────────────────────────────────────────────────────────────────────
-- DELETE trade.planogram_skus extras (los que sobreviven pero no están en prod)
-- ──────────────────────────────────────────────────────────────────────
DELETE FROM trade.planogram_skus
  WHERE sku NOT IN (SELECT sku FROM keep_planogram_skus);

-- ──────────────────────────────────────────────────────────────────────
-- Cleanup: products_top_sellers también se ve afectada (FK al catalog.products)
-- ──────────────────────────────────────────────────────────────────────
-- catalog.products_top_sellers es MATVIEW en local — la refrescaremos después si hace falta

-- Re-enable triggers
ALTER TABLE catalog.products              ENABLE TRIGGER ALL;
ALTER TABLE commercial.product_prices     ENABLE TRIGGER ALL;
ALTER TABLE commercial.stock              ENABLE TRIGGER ALL;
ALTER TABLE commercial.stock_movements    ENABLE TRIGGER ALL;
ALTER TABLE commercial.order_lines        ENABLE TRIGGER ALL;
ALTER TABLE commercial.vendor_sale_lines  ENABLE TRIGGER ALL;
ALTER TABLE trade.planogram_skus          ENABLE TRIGGER ALL;

SET session_replication_role = 'origin';
COMMIT;

-- Verify final counts
SELECT 'catalog.products'           AS t, COUNT(*) FROM catalog.products
UNION ALL SELECT 'trade.planogram_skus',     COUNT(*) FROM trade.planogram_skus
UNION ALL SELECT 'commercial.product_prices',COUNT(*) FROM commercial.product_prices
UNION ALL SELECT 'commercial.stock',         COUNT(*) FROM commercial.stock
UNION ALL SELECT 'commercial.stock_movements', COUNT(*) FROM commercial.stock_movements
UNION ALL SELECT 'commercial.order_lines',   COUNT(*) FROM commercial.order_lines;
