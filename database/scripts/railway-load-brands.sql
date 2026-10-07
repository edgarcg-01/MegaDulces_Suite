BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE catalog.brands DISABLE TRIGGER ALL;

CREATE TEMP TABLE tmp_b (
  id uuid, tenant_id uuid, nombre varchar, activo boolean, orden integer,
  created_at timestamptz, created_by uuid,
  updated_at timestamptz, updated_by uuid,
  deleted_at timestamptz, deleted_by uuid,
  code varchar, is_commercial boolean, display_name varchar
);

\COPY tmp_b FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-brands-all.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO catalog.brands
  (id, tenant_id, nombre, orden,
   created_at, created_by, updated_at, updated_by, deleted_at, deleted_by,
   code, is_commercial, display_name)
SELECT id, tenant_id, nombre, orden,
       created_at, created_by, updated_at, updated_by, deleted_at, deleted_by,
       code, is_commercial, display_name
FROM tmp_b
ON CONFLICT ON CONSTRAINT brands_tenant_nombre_unique DO NOTHING;

ALTER TABLE catalog.brands ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT COUNT(*) AS brands FROM catalog.brands;
