-- =============================================================================
-- Backfill stats.puntuacionTotal de visitas históricas con score=0
-- =============================================================================
-- Causa: 10 visitas creadas ANTES de que se sincronizara el peso de
-- 'Sin exhibidor' en scoring_weights. Se guardaron con stats.puntuacionTotal=0
-- aunque las exhibiciones individuales tienen puntuacionCalculada correcta.
--
-- Fix: recalcular stats.puntuacionTotal usando los pesos actuales (ya
-- sincronizados con fix-sin-exhibidor-scoring-weight.sql) y actualizar el
-- JSONB en daily_captures.
--
-- Reversible:
--   UPDATE daily_captures SET stats = jsonb_set(stats, '{puntuacionTotal}', '0')
--   WHERE id IN (<lista>);
-- =============================================================================

BEGIN;

WITH pesos AS (
  SELECT tipo, LOWER(TRIM(nombre)) AS nombre, valor::float
  FROM scoring_weights sw
  JOIN scoring_config_versions scv ON scv.id = sw.config_version_id
  WHERE scv.activo = true
),
visitas_recalc AS (
  SELECT dc.id,
         SUM(
           COALESCE((SELECT valor FROM pesos WHERE tipo='exhibicion'
                     AND nombre = LOWER(TRIM((SELECT value FROM catalogs WHERE id = (ex->>'conceptoId')::uuid)))), 0)
           *
           COALESCE((SELECT valor FROM pesos WHERE tipo='posicion'
                     AND nombre = LOWER(TRIM((SELECT value FROM catalogs WHERE id = (ex->>'ubicacionId')::uuid)))), 0)
           *
           LEAST(COALESCE((SELECT valor FROM pesos WHERE tipo='ejecucion'
                           AND nombre = LOWER(TRIM(ex->>'nivelEjecucion'))), 0), 1)
         ) AS nuevo_total
  FROM daily_captures dc, jsonb_array_elements(dc.exhibiciones) ex
  WHERE (dc.stats->>'puntuacionTotal')::float = 0
  GROUP BY dc.id
)
UPDATE daily_captures dc
SET stats = jsonb_set(stats, '{puntuacionTotal}', to_jsonb(ROUND(v.nuevo_total::numeric, 2)::float))
FROM visitas_recalc v
WHERE dc.id = v.id AND v.nuevo_total > 0;

COMMIT;

-- Verificación
SELECT 'visitas recuperadas' AS check,
       count(*) FILTER (WHERE (stats->>'puntuacionTotal')::float > 0 AND (stats->>'puntuacionTotal')::float < 100) AS con_score_nuevo,
       count(*) FILTER (WHERE (stats->>'puntuacionTotal')::float = 0) AS quedan_en_0
FROM daily_captures;
