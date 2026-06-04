-- Sync catalog + commercial (sin tocar identity ni public/trade).
-- session_replication_role=replica + DISABLE TRIGGER ALL para bypassar FK + RLS + auto_populate_tenant_id triggers.

\set csv_dir 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv'

BEGIN;
SET session_replication_role = 'replica';

-- Disable triggers (incluyendo FK) en todas las tablas afectadas + las que referencian
ALTER TABLE catalog.brands              DISABLE TRIGGER ALL;
ALTER TABLE catalog.categories          DISABLE TRIGGER ALL;
ALTER TABLE catalog.products            DISABLE TRIGGER ALL;
ALTER TABLE commercial.warehouses       DISABLE TRIGGER ALL;
ALTER TABLE commercial.price_lists      DISABLE TRIGGER ALL;
ALTER TABLE commercial.customers        DISABLE TRIGGER ALL;
ALTER TABLE commercial.product_prices   DISABLE TRIGGER ALL;
ALTER TABLE commercial.stock            DISABLE TRIGGER ALL;
ALTER TABLE commercial.recommended_baskets DISABLE TRIGGER ALL;
-- identity.users.customer_id FK apunta a commercial.customers
ALTER TABLE identity.users              DISABLE TRIGGER ALL;

-- DELETE en lugar de TRUNCATE: TRUNCATE chequea FK constraints a nivel metadata
-- (ignora DISABLE TRIGGER), DELETE sí respeta triggers desactivados.
DELETE FROM commercial.product_prices;
DELETE FROM commercial.stock;
DELETE FROM commercial.recommended_baskets;
DELETE FROM commercial.customers;
DELETE FROM commercial.warehouses;
DELETE FROM commercial.price_lists;
DELETE FROM catalog.products;
DELETE FROM catalog.brands;
DELETE FROM catalog.categories;

-- COPY en orden inverso (padres → hijos)
\COPY catalog.categories        FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/catalog__categories.csv'        WITH (FORMAT csv, HEADER true)
\COPY catalog.brands            FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/catalog__brands.csv'            WITH (FORMAT csv, HEADER true)
\COPY catalog.products (id, tenant_id, brand_id, nombre, activo, orden, puntuacion, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, embedding, embedding_source_text, embedding_updated_at, sku, barcode, category_id, unit_purchase, unit_sale, factor_purchase, factor_sale, iva_rate, ieps_rate, description, cost_with_tax, cost_per_case, cost_base, location, location_warehouse, iva_purchase_rate, ieps_purchase_rate, loyalty_points, image_url, image_source, image_storage_key, image_updated_at) FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/catalog__products.csv' WITH (FORMAT csv, HEADER true)
\COPY commercial.warehouses (id, tenant_id, code, name, address, is_default, active, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by) FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/commercial__warehouses.csv' WITH (FORMAT csv, HEADER true)
\COPY commercial.price_lists    FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/commercial__price_lists.csv'    WITH (FORMAT csv, HEADER true)
\COPY commercial.customers      FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/commercial__customers.csv'      WITH (FORMAT csv, HEADER true)
\COPY commercial.product_prices FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/commercial__product_prices.csv' WITH (FORMAT csv, HEADER true)
\COPY commercial.stock          FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/commercial__stock.csv'          WITH (FORMAT csv, HEADER true)

-- Re-enable triggers
ALTER TABLE catalog.brands              ENABLE TRIGGER ALL;
ALTER TABLE catalog.categories          ENABLE TRIGGER ALL;
ALTER TABLE catalog.products            ENABLE TRIGGER ALL;
ALTER TABLE commercial.warehouses       ENABLE TRIGGER ALL;
ALTER TABLE commercial.price_lists      ENABLE TRIGGER ALL;
ALTER TABLE commercial.customers        ENABLE TRIGGER ALL;
ALTER TABLE commercial.product_prices   ENABLE TRIGGER ALL;
ALTER TABLE commercial.stock            ENABLE TRIGGER ALL;
ALTER TABLE commercial.recommended_baskets ENABLE TRIGGER ALL;
ALTER TABLE identity.users              ENABLE TRIGGER ALL;

SET session_replication_role = 'origin';
COMMIT;

-- Verify
SELECT 'catalog.brands' AS t, COUNT(*) FROM catalog.brands
UNION ALL SELECT 'catalog.categories', COUNT(*) FROM catalog.categories
UNION ALL SELECT 'catalog.products', COUNT(*) FROM catalog.products
UNION ALL SELECT 'commercial.warehouses', COUNT(*) FROM commercial.warehouses
UNION ALL SELECT 'commercial.price_lists', COUNT(*) FROM commercial.price_lists
UNION ALL SELECT 'commercial.customers', COUNT(*) FROM commercial.customers
UNION ALL SELECT 'commercial.product_prices', COUNT(*) FROM commercial.product_prices
UNION ALL SELECT 'commercial.stock', COUNT(*) FROM commercial.stock
ORDER BY 1;
