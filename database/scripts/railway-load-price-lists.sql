BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE commercial.price_lists DISABLE TRIGGER ALL;

CREATE TEMP TABLE tmp_pl (
  id uuid, tenant_id uuid, code varchar, name varchar,
  currency varchar, valid_from date, valid_to date,
  is_default boolean, active boolean, notes text,
  created_at timestamptz, created_by uuid,
  updated_at timestamptz, updated_by uuid,
  deleted_at timestamptz, deleted_by uuid
);

\COPY tmp_pl FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-price-lists-extras.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO commercial.price_lists
  (id, tenant_id, code, name, currency, valid_from, valid_to,
   is_default, active, notes,
   created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
SELECT id, tenant_id, code, name, currency, valid_from, valid_to,
       is_default, active, notes,
       created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
FROM tmp_pl
ON CONFLICT (id) DO NOTHING;

ALTER TABLE commercial.price_lists ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT COUNT(*) AS price_lists FROM commercial.price_lists;
