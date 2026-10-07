-- Cargar customers extras de local. NULL en store_id y route_id porque las FKs
-- pueden apuntar a UUIDs que no existen en Railway (trade.stores e logistics.routes
-- son seedeados independientemente).

BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE commercial.customers DISABLE TRIGGER ALL;

CREATE TEMP TABLE tmp_c (
  id uuid, tenant_id uuid, code varchar, name varchar, legal_name varchar,
  rfc varchar, email varchar, phone varchar, billing_address jsonb,
  shipping_address jsonb, store_id uuid, default_price_list_id uuid,
  credit_limit numeric, balance numeric, payment_terms_days integer,
  active boolean, notes text,
  created_at timestamptz, created_by uuid,
  updated_at timestamptz, updated_by uuid,
  deleted_at timestamptz, deleted_by uuid,
  route_id uuid
);

\COPY tmp_c FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-customers.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO commercial.customers
  (id, tenant_id, code, name, legal_name, rfc, email, phone,
   billing_address, shipping_address, store_id, default_price_list_id,
   credit_limit, balance, payment_terms_days, active, notes,
   created_at, created_by, updated_at, updated_by, deleted_at, deleted_by,
   route_id)
SELECT
  tc.id, tc.tenant_id, tc.code, tc.name, tc.legal_name, tc.rfc, tc.email, tc.phone,
  tc.billing_address, tc.shipping_address,
  -- store_id: solo si existe en Railway (trade.stores tiene IDs distintos)
  (SELECT id FROM trade.stores WHERE id = tc.store_id) AS store_id,
  -- default_price_list_id: solo si existe en Railway
  (SELECT id FROM commercial.price_lists WHERE id = tc.default_price_list_id) AS default_price_list_id,
  tc.credit_limit, tc.balance, tc.payment_terms_days, tc.active, tc.notes,
  tc.created_at, tc.created_by, tc.updated_at, tc.updated_by, tc.deleted_at, tc.deleted_by,
  -- route_id: solo si existe en Railway
  (SELECT id FROM logistics.routes WHERE id = tc.route_id) AS route_id
FROM tmp_c tc
ON CONFLICT (id) DO NOTHING;

ALTER TABLE commercial.customers ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT COUNT(*) AS customers FROM commercial.customers;
