-- Inventario completo: tablas y columnas por schema.
-- EXCLUIDO: schema `trade` + VIEWs en public.* que apuntan a trade.
-- EXCLUIDO: knex_migrations / knex_migrations_lock (cada DB tiene su propio histórico).

-- Lista de tablas trade-related en public.* (para excluir):
--   stores, zones, catalogs, daily_captures, daily_assignments, visits,
--   exhibitions, exhibition_photos, valid_exhibition_combinations,
--   scoring_config, scoring_config_versions, scoring_weights,
--   rubric_criteria, rubric_levels

-- 1. TABLAS por schema (tablas reales, no views)
WITH excluded AS (
  SELECT unnest(ARRAY[
    'stores','zones','catalogs','daily_captures','daily_assignments',
    'visits','exhibitions','exhibition_photos','valid_exhibition_combinations',
    'scoring_config','scoring_config_versions','scoring_weights',
    'rubric_criteria','rubric_levels',
    'knex_migrations','knex_migrations_lock'
  ]) AS name
)
SELECT
  n.nspname || '.' || c.relname AS object,
  CASE c.relkind
    WHEN 'r' THEN 'TABLE'
    WHEN 'v' THEN 'VIEW'
    WHEN 'm' THEN 'MATVIEW'
    WHEN 'f' THEN 'FOREIGN'
    WHEN 'S' THEN 'SEQUENCE'
  END AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','trade')
  AND c.relkind IN ('r','v','m','f','S')
  AND NOT (n.nspname = 'public' AND c.relname IN (SELECT name FROM excluded))
ORDER BY n.nspname, c.relname;
