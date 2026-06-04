-- Snapshot de columnas por tabla, EXCLUYENDO trade y trade-VIEWs en public.
WITH excluded_public AS (
  SELECT unnest(ARRAY[
    'stores','zones','catalogs','daily_captures','daily_assignments',
    'visits','exhibitions','exhibition_photos','valid_exhibition_combinations',
    'scoring_config','scoring_config_versions','scoring_weights',
    'rubric_criteria','rubric_levels',
    'knex_migrations','knex_migrations_lock'
  ]) AS name
)
SELECT
  c.table_schema || '.' || c.table_name AS table_qual,
  c.column_name,
  c.data_type,
  c.is_nullable,
  COALESCE(c.column_default, '') AS default_val
FROM information_schema.columns c
WHERE c.table_schema NOT IN ('pg_catalog','information_schema','trade')
  AND NOT (c.table_schema = 'public' AND c.table_name IN (SELECT name FROM excluded_public))
ORDER BY c.table_schema, c.table_name, c.ordinal_position;
