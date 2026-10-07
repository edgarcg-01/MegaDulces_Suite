BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE catalog.categories DISABLE TRIGGER ALL;

CREATE TEMP TABLE tmp_cat (
  id uuid, tenant_id uuid, code varchar, name varchar, activo boolean, orden integer,
  created_at timestamptz, created_by uuid,
  updated_at timestamptz, updated_by uuid,
  deleted_at timestamptz, deleted_by uuid
);

\COPY tmp_cat FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-categories.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO catalog.categories
  (id, tenant_id, code, name, orden,
   created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
SELECT id, tenant_id, code, name, orden,
       created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
FROM tmp_cat
ON CONFLICT (id) DO NOTHING;

ALTER TABLE catalog.categories ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT COUNT(*) AS categories FROM catalog.categories;
