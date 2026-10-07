-- Rollback catalog + commercial al estado del backup original.
-- No toca identity ni public.

BEGIN;
SET session_replication_role = 'replica';

ALTER TABLE catalog.brands              DISABLE TRIGGER ALL;
ALTER TABLE catalog.categories          DISABLE TRIGGER ALL;
ALTER TABLE catalog.products            DISABLE TRIGGER ALL;
ALTER TABLE commercial.warehouses       DISABLE TRIGGER ALL;
ALTER TABLE commercial.price_lists      DISABLE TRIGGER ALL;
ALTER TABLE commercial.customers        DISABLE TRIGGER ALL;
ALTER TABLE commercial.product_prices   DISABLE TRIGGER ALL;
ALTER TABLE commercial.stock            DISABLE TRIGGER ALL;
ALTER TABLE commercial.recommended_baskets DISABLE TRIGGER ALL;
ALTER TABLE identity.users              DISABLE TRIGGER ALL;

DELETE FROM commercial.product_prices;
DELETE FROM commercial.stock;
DELETE FROM commercial.recommended_baskets;
DELETE FROM commercial.customers;
DELETE FROM commercial.warehouses;
DELETE FROM commercial.price_lists;
DELETE FROM catalog.products;
DELETE FROM catalog.brands;
DELETE FROM catalog.categories;

COMMIT;
