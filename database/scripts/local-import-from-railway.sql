-- Alinear local con Railway: import de catalog + commercial + trade.planogram_skus
-- Estrategia: DELETE-ALL + INSERT desde CSV (Railway export).
-- NO toca identity, public.*, ni logistics.

BEGIN;
SET session_replication_role = 'replica';

-- ──────────────────────────────────────────────────────────────────────
-- Disable triggers en las tablas a alterar + las que tienen FK entrantes
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE catalog.categories            DISABLE TRIGGER ALL;
ALTER TABLE catalog.brands                DISABLE TRIGGER ALL;
ALTER TABLE catalog.products              DISABLE TRIGGER ALL;
-- catalog.products_top_sellers es MATVIEW en local — la refrescamos manualmente al final
ALTER TABLE commercial.price_lists        DISABLE TRIGGER ALL;
ALTER TABLE commercial.warehouses         DISABLE TRIGGER ALL;
ALTER TABLE commercial.customers          DISABLE TRIGGER ALL;
ALTER TABLE commercial.product_prices     DISABLE TRIGGER ALL;
ALTER TABLE commercial.stock              DISABLE TRIGGER ALL;
ALTER TABLE commercial.stock_movements    DISABLE TRIGGER ALL;
ALTER TABLE commercial.order_lines        DISABLE TRIGGER ALL;
ALTER TABLE commercial.vendor_sale_lines  DISABLE TRIGGER ALL;
ALTER TABLE commercial.recommended_baskets DISABLE TRIGGER ALL;
ALTER TABLE trade.planogram_skus          DISABLE TRIGGER ALL;
ALTER TABLE identity.users                DISABLE TRIGGER ALL;

-- ──────────────────────────────────────────────────────────────────────
-- DELETE en orden FK (hijo → padre)
-- ──────────────────────────────────────────────────────────────────────
-- Tablas que referencian products/customers/warehouses
DELETE FROM commercial.product_prices;
DELETE FROM commercial.stock;
DELETE FROM commercial.stock_movements;
DELETE FROM commercial.order_lines;
DELETE FROM commercial.vendor_sale_lines;
DELETE FROM commercial.recommended_baskets;
DELETE FROM trade.planogram_skus;
-- catalog.products_top_sellers (MATVIEW local) — no DELETE; refresh al final
-- Master
DELETE FROM catalog.products;
DELETE FROM catalog.brands;
DELETE FROM catalog.categories;
DELETE FROM commercial.customers;
DELETE FROM commercial.warehouses;
DELETE FROM commercial.price_lists;

-- ──────────────────────────────────────────────────────────────────────
-- Agregar column `articulo` si no existe (drift de Railway)
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS articulo varchar;

-- ──────────────────────────────────────────────────────────────────────
-- INSERT (orden padre → hijo)
-- ──────────────────────────────────────────────────────────────────────
\COPY catalog.categories FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/catalog__categories.csv' WITH (FORMAT csv, HEADER true)
\COPY catalog.brands FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/catalog__brands.csv' WITH (FORMAT csv, HEADER true)
\COPY catalog.products (id, tenant_id, brand_id, nombre, activo, orden, puntuacion, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, embedding, embedding_source_text, embedding_updated_at, articulo, sku, barcode, category_id, unit_purchase, unit_sale, factor_purchase, factor_sale, iva_rate, ieps_rate, description, cost_with_tax, cost_per_case, cost_base, location, location_warehouse, iva_purchase_rate, ieps_purchase_rate, loyalty_points, image_url, image_source, image_storage_key, image_updated_at) FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/catalog__products.csv' WITH (FORMAT csv, HEADER true)
-- catalog.products_top_sellers: refresh MV al final (no COPY)
\COPY commercial.price_lists FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/commercial__price_lists.csv' WITH (FORMAT csv, HEADER true)
-- warehouses: Railway YA tiene kind + owner_user_id (mig 200000) — mismo orden de cols
\COPY commercial.warehouses FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/commercial__warehouses.csv' WITH (FORMAT csv, HEADER true)
\COPY commercial.customers FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/commercial__customers.csv' WITH (FORMAT csv, HEADER true)
\COPY commercial.product_prices FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/commercial__product_prices.csv' WITH (FORMAT csv, HEADER true)
\COPY commercial.stock FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/commercial__stock.csv' WITH (FORMAT csv, HEADER true)
-- planogram_skus.activo es GENERATED en local (deleted_at IS NULL) — excluir
\COPY trade.planogram_skus (id, tenant_id, product_id, sku, orden_exhibicion, categoria_exhibicion, posicion_shelf, vigente_desde, vigente_hasta, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by) FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/from-railway/trade__planogram_skus.csv' WITH (FORMAT csv, HEADER true)

-- Re-enable triggers
ALTER TABLE catalog.categories            ENABLE TRIGGER ALL;
ALTER TABLE catalog.brands                ENABLE TRIGGER ALL;
ALTER TABLE catalog.products              ENABLE TRIGGER ALL;
-- products_top_sellers MATVIEW — refresh al final
ALTER TABLE commercial.price_lists        ENABLE TRIGGER ALL;
ALTER TABLE commercial.warehouses         ENABLE TRIGGER ALL;
ALTER TABLE commercial.customers          ENABLE TRIGGER ALL;
ALTER TABLE commercial.product_prices     ENABLE TRIGGER ALL;
ALTER TABLE commercial.stock              ENABLE TRIGGER ALL;
ALTER TABLE commercial.stock_movements    ENABLE TRIGGER ALL;
ALTER TABLE commercial.order_lines        ENABLE TRIGGER ALL;
ALTER TABLE commercial.vendor_sale_lines  ENABLE TRIGGER ALL;
ALTER TABLE commercial.recommended_baskets ENABLE TRIGGER ALL;
ALTER TABLE trade.planogram_skus          ENABLE TRIGGER ALL;
ALTER TABLE identity.users                ENABLE TRIGGER ALL;

SET session_replication_role = 'origin';
COMMIT;

-- Verify
SELECT 'catalog.brands'              AS t, COUNT(*) FROM catalog.brands
UNION ALL SELECT 'catalog.categories',       COUNT(*) FROM catalog.categories
UNION ALL SELECT 'catalog.products',         COUNT(*) FROM catalog.products
UNION ALL SELECT 'catalog.products_top_sellers', COUNT(*) FROM catalog.products_top_sellers
UNION ALL SELECT 'commercial.price_lists',   COUNT(*) FROM commercial.price_lists
UNION ALL SELECT 'commercial.warehouses',    COUNT(*) FROM commercial.warehouses
UNION ALL SELECT 'commercial.customers',     COUNT(*) FROM commercial.customers
UNION ALL SELECT 'commercial.product_prices', COUNT(*) FROM commercial.product_prices
UNION ALL SELECT 'commercial.stock',         COUNT(*) FROM commercial.stock
UNION ALL SELECT 'trade.planogram_skus',     COUNT(*) FROM trade.planogram_skus
ORDER BY 1;
