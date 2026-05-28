-- =============================================================================
-- Fix /seguimiento visitas en 0 — sincronizar peso 'Sin exhibidor' en scoring_weights
-- =============================================================================
-- Generado: 2026-05-27
--
-- Causa: el catálogo `catalogs` tiene 'Sin exhibidor' con puntuacion=0.50,
-- pero `scoring_weights` (versión activa v1.0) NO tiene esa fila. Esto causa
-- que el backend devuelva 0 puntos al recalcular visitas con ese concepto,
-- aunque el frontend offline calcule bien (lee puntuacion del catálogo).
--
-- Resultado: 10 visitas históricas en `daily_captures` tienen
-- `stats.puntuacionTotal=0` indebidamente.
--
-- Fix: INSERT del peso faltante.
-- =============================================================================

BEGIN;

INSERT INTO scoring_weights (id, tenant_id, config_version_id, tipo, nombre, valor, created_at, updated_at)
SELECT
  gen_random_uuid(),
  '00000000-0000-0000-0000-00000000d01c',
  scv.id,
  'exhibicion',
  'Sin exhibidor',
  0.50,
  NOW(),
  NOW()
FROM scoring_config_versions scv
WHERE scv.activo = true
  AND NOT EXISTS (
    SELECT 1 FROM scoring_weights sw
    WHERE sw.config_version_id = scv.id
      AND sw.tipo = 'exhibicion'
      AND sw.nombre = 'Sin exhibidor'
  );

COMMIT;

-- Verificación
SELECT 'peso Sin exhibidor' AS check, sw.tipo, sw.nombre, sw.valor, scv.version
FROM scoring_weights sw
JOIN scoring_config_versions scv ON scv.id = sw.config_version_id
WHERE sw.nombre = 'Sin exhibidor' AND scv.activo = true;
