BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE erp.staff DISABLE TRIGGER ALL;

CREATE TEMP TABLE tmp_s (
  id uuid, tenant_id uuid, code varchar, name varchar, user_id uuid,
  activo boolean, created_at timestamptz, updated_at timestamptz
);

\COPY tmp_s FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-staff.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO erp.staff (id, tenant_id, code, name, user_id, activo, created_at, updated_at)
SELECT
  ts.id, ts.tenant_id, ts.code, ts.name,
  (SELECT id FROM identity.users WHERE id = ts.user_id) AS user_id,
  ts.activo, ts.created_at, ts.updated_at
FROM tmp_s ts
ON CONFLICT (id) DO NOTHING;

ALTER TABLE erp.staff ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT COUNT(*) AS staff FROM erp.staff;
