BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE commercial.warehouses DISABLE TRIGGER ALL;

CREATE TEMP TABLE tmp_w (
  id uuid, tenant_id uuid, code varchar, name varchar, address text,
  is_default boolean, active boolean,
  created_at timestamptz, created_by uuid,
  updated_at timestamptz, updated_by uuid,
  deleted_at timestamptz, deleted_by uuid
);

\COPY tmp_w FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-warehouses-extras.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO commercial.warehouses
  (id, tenant_id, code, name, address, is_default, active,
   created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
SELECT id, tenant_id, code, name, address, is_default, active,
       created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
FROM tmp_w
ON CONFLICT (id) DO NOTHING;

ALTER TABLE commercial.warehouses ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT COUNT(*) AS warehouses FROM commercial.warehouses;
