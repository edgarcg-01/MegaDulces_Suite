-- Snapshot de indexes (no-PK porque PKs van con la tabla) + constraints únicos/FK.
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
  n.nspname || '.' || cls.relname || '.' || i.indexrelid::regclass::text AS object,
  am.amname AS index_type,
  pg_get_indexdef(i.indexrelid) AS def
FROM pg_index i
JOIN pg_class cls ON cls.oid = i.indrelid
JOIN pg_namespace n ON n.oid = cls.relnamespace
JOIN pg_class idx ON idx.oid = i.indexrelid
JOIN pg_am am ON am.oid = idx.relam
WHERE n.nspname NOT IN ('pg_catalog','information_schema','trade')
  AND NOT (n.nspname = 'public' AND cls.relname IN (SELECT name FROM excluded_public))
  AND NOT i.indisprimary  -- exclude PKs (they're metadata of the table)
ORDER BY n.nspname, cls.relname, idx.relname;
