BEGIN;
SET session_replication_role = 'replica';
ALTER TABLE logistics.drivers DISABLE TRIGGER ALL;
ALTER TABLE logistics.vehicles DISABLE TRIGGER ALL;

-- DRIVERS
CREATE TEMP TABLE tmp_d (
  id uuid, tenant_id uuid, full_name varchar, roles text[], employee_type varchar,
  status varchar, nss varchar, phone varchar, emergency_contact varchar,
  user_id uuid, active boolean, notes text,
  created_at timestamptz, created_by uuid,
  updated_at timestamptz, updated_by uuid,
  deleted_at timestamptz, deleted_by uuid
);
\COPY tmp_d FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-drivers.csv' WITH (FORMAT csv, HEADER true)
INSERT INTO logistics.drivers
  (id, tenant_id, full_name, roles, employee_type, status, nss, phone,
   emergency_contact, user_id, active, notes,
   created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
SELECT
  td.id, td.tenant_id, td.full_name, td.roles, td.employee_type, td.status,
  td.nss, td.phone, td.emergency_contact,
  -- user_id: solo si existe en Railway
  (SELECT id FROM identity.users WHERE id = td.user_id) AS user_id,
  td.active, td.notes,
  td.created_at, td.created_by, td.updated_at, td.updated_by, td.deleted_at, td.deleted_by
FROM tmp_d td
ON CONFLICT (id) DO NOTHING;

-- VEHICLES
CREATE TEMP TABLE tmp_v (
  id uuid, tenant_id uuid, plate varchar, model varchar, brand varchar, year integer,
  fuel_efficiency_km_l numeric, capacity_boxes integer, capacity_kg numeric,
  status varchar, notes text, active boolean,
  created_at timestamptz, created_by uuid,
  updated_at timestamptz, updated_by uuid,
  deleted_at timestamptz, deleted_by uuid
);
\COPY tmp_v FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/local-vehicles.csv' WITH (FORMAT csv, HEADER true)
INSERT INTO logistics.vehicles
  (id, tenant_id, plate, model, brand, year, fuel_efficiency_km_l,
   capacity_boxes, capacity_kg, status, notes, active,
   created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
SELECT id, tenant_id, plate, model, brand, year, fuel_efficiency_km_l,
       capacity_boxes, capacity_kg, status, notes, active,
       created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
FROM tmp_v
ON CONFLICT (id) DO NOTHING;

ALTER TABLE logistics.drivers ENABLE TRIGGER ALL;
ALTER TABLE logistics.vehicles ENABLE TRIGGER ALL;
SET session_replication_role = 'origin';
COMMIT;

SELECT 'drivers' AS t, COUNT(*) FROM logistics.drivers
UNION ALL SELECT 'vehicles', COUNT(*) FROM logistics.vehicles;
