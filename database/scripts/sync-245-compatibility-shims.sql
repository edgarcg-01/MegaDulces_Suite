-- =============================================================================
-- Sincronización compatibility shims a postgres_platform en .245
-- =============================================================================
-- Generado: 2026-05-27
--
-- Aplica las 2 migraciones aditivas creadas hoy en Docker local (5433) a la
-- DB remota .245 para mantener paridad de schema.
--
-- NO incluye:
--   - 20260527120000 (pgvector extension + embedding cols) — requiere instalar
--     pgvector en .245 primero (no disponible como Windows binary).
--   - 20260527150000 (trigger staleness) — depende de columnas embedding.
--
-- Idempotente: chequea existencia antes de cada ALTER.
--
-- Ejecutar con (cualquiera):
--   psql -h 192.168.0.245 -U postgres -d postgres_platform -f sync-245-compatibility-shims.sql
--   pgAdmin → conectar a .245 → Query Tool → abrir este archivo → Execute
--   DBeaver/etc → mismo flujo
--
-- Reversible:
--   ALTER TABLE <each> DROP COLUMN activo;
--   ALTER TABLE zones DROP COLUMN is_system;
--   ALTER TABLE daily_captures DROP COLUMN captured_by_username;
--   DELETE FROM knex_migrations WHERE name IN
--     ('20260527130000_add_activo_virtual_to_multitenant_tables.js',
--      '20260527140000_add_legacy_columns_zones_daily_captures.js');
-- =============================================================================

BEGIN;

-- ── 1. activo virtual en 12 tablas (migración 20260527130000) ───────────────
DO $$
DECLARE
  tbl TEXT;
  tablas TEXT[] := ARRAY[
    'catalogs', 'daily_assignments', 'daily_captures', 'exhibition_photos',
    'exhibitions', 'role_permissions', 'rubric_levels', 'scoring_config',
    'scoring_config_versions', 'scoring_weights', 'visits', 'zones'
  ];
BEGIN
  FOREACH tbl IN ARRAY tablas LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'activo'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'deleted_at'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED',
        tbl
      );
      RAISE NOTICE '[130000] % .activo agregado', tbl;
    ELSE
      RAISE NOTICE '[130000] % skip (ya existe o sin deleted_at)', tbl;
    END IF;
  END LOOP;
END $$;

-- ── 2. zones.is_system + daily_captures.captured_by_username (mig 140000) ───
DO $$
DECLARE
  cnt INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='zones' AND column_name='is_system'
  ) THEN
    ALTER TABLE zones ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;
    RAISE NOTICE '[140000] zones.is_system agregado';
  ELSE
    RAISE NOTICE '[140000] zones.is_system skip (ya existe)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='daily_captures' AND column_name='captured_by_username'
  ) THEN
    ALTER TABLE daily_captures ADD COLUMN captured_by_username VARCHAR(150);
    UPDATE daily_captures dc
       SET captured_by_username = u.username
       FROM users u
       WHERE u.id = dc.user_id AND dc.captured_by_username IS NULL;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    RAISE NOTICE '[140000] daily_captures.captured_by_username agregado + backfill % rows', cnt;
  ELSE
    RAISE NOTICE '[140000] daily_captures.captured_by_username skip (ya existe)';
  END IF;
END $$;

-- ── 3. Registrar las migraciones en knex_migrations ─────────────────────────
DO $$
DECLARE
  next_batch INT;
BEGIN
  SELECT COALESCE(MAX(batch), 0) + 1 INTO next_batch FROM knex_migrations;

  IF NOT EXISTS (
    SELECT 1 FROM knex_migrations
    WHERE name = '20260527130000_add_activo_virtual_to_multitenant_tables.js'
  ) THEN
    INSERT INTO knex_migrations (name, batch, migration_time)
    VALUES ('20260527130000_add_activo_virtual_to_multitenant_tables.js', next_batch, NOW());
    RAISE NOTICE '[knex_migrations] 130000 registrada (batch %)', next_batch;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM knex_migrations
    WHERE name = '20260527140000_add_legacy_columns_zones_daily_captures.js'
  ) THEN
    INSERT INTO knex_migrations (name, batch, migration_time)
    VALUES ('20260527140000_add_legacy_columns_zones_daily_captures.js', next_batch, NOW());
    RAISE NOTICE '[knex_migrations] 140000 registrada (batch %)', next_batch;
  END IF;
END $$;

COMMIT;

-- ── 4. Verify (queries informativas, no modifican) ──────────────────────────
SELECT
  COUNT(*) FILTER (WHERE column_name='activo') AS tablas_con_activo,
  12 AS esperado
FROM information_schema.columns
WHERE table_schema='public' AND column_name='activo'
  AND table_name IN ('catalogs','daily_assignments','daily_captures','exhibition_photos',
                     'exhibitions','role_permissions','rubric_levels','scoring_config',
                     'scoring_config_versions','scoring_weights','visits','zones');

SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='zones' AND column_name='is_system'
) AS zones_is_system;

SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='daily_captures' AND column_name='captured_by_username'
) AS dc_captured_by_username;

SELECT COUNT(*) AS daily_captures_with_username
FROM daily_captures WHERE captured_by_username IS NOT NULL;
