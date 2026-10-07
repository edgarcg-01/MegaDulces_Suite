-- =============================================================================
-- Fix /daily-captures 500 — compat shim para schema multi-tenant
-- =============================================================================
-- Generado: 2026-05-27
--
-- Causa: la tabla `daily_captures` en `postgres_platform` (Docker local + .245)
-- es el schema multi-tenant nuevo (tenant_id, scoring, audit), pero el código
-- legacy de `apps/api/src/modules/daily-captures/` aún hace INSERT con:
--   - `zona_captura` (no existe en tabla)
--   - sin `tenant_id` (NOT NULL sin default)
--
-- Solución aditiva e idempotente:
--   1. ADD COLUMN zona_captura (NULL-able, no rompe inserts existentes).
--   2. Backfill desde users.zona donde se pueda.
--   3. SET DEFAULT tenant_id = mega_dulces UUID (compat con código legacy).
--
-- Ejecutar con:
--   psql -h localhost -p 5433 -U postgres -d postgres_platform -f fix-daily-captures-mt-shim.sql
--   (o via DBeaver/pgAdmin)
--
-- Reversible:
--   ALTER TABLE daily_captures DROP COLUMN IF EXISTS zona_captura;
--   ALTER TABLE daily_captures ALTER COLUMN tenant_id DROP DEFAULT;
-- =============================================================================

BEGIN;

-- ── 1. zona_captura ─────────────────────────────────────────────────────────
ALTER TABLE daily_captures ADD COLUMN IF NOT EXISTS zona_captura VARCHAR(100);

-- ── 2. Backfill desde users.zona_id → zones.name ────────────────────────────
-- Schema multi-tenant usa users.zona_id (UUID) y zones.name (string).
UPDATE daily_captures dc
SET zona_captura = COALESCE(z.name, 'SIN_ZONA')
FROM users u
LEFT JOIN zones z ON z.id = u.zona_id
WHERE dc.user_id = u.id AND dc.zona_captura IS NULL;

-- ── 3. tenant_id default = Mega Dulces (compat shim) ────────────────────────
-- El INSERT del service no incluye tenant_id. Hasta migrar el código al
-- TenantContextService, asignamos por default a mega_dulces. Esto NO bloquea
-- multi-tenancy real: cuando el service haga INSERT con tenant_id explícito,
-- el DEFAULT se ignora.
ALTER TABLE daily_captures
  ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-00000000d01c';

COMMIT;

-- Verificación
SELECT 'zona_captura agregada' AS check, count(*) AS rows_con_zona
FROM daily_captures WHERE zona_captura IS NOT NULL;

SELECT 'tenant_id default' AS check, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='daily_captures' AND column_name='tenant_id';
