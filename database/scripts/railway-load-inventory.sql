BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE inventory.products DISABLE TRIGGER ALL;
ALTER TABLE inventory.products_active DISABLE TRIGGER ALL;

-- inventory.products
\COPY inventory.products FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-inventory-products.csv' WITH (FORMAT csv, HEADER true)

-- inventory.products_active
\COPY inventory.products_active FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-inventory-active.csv' WITH (FORMAT csv, HEADER true)

ALTER TABLE inventory.products ENABLE TRIGGER ALL;
ALTER TABLE inventory.products_active ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT 'inventory.products' AS t, COUNT(*) FROM inventory.products
UNION ALL SELECT 'inventory.products_active', COUNT(*) FROM inventory.products_active;
