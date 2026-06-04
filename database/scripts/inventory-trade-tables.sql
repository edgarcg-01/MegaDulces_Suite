-- Inventario de tablas trade marketing en public.*:
-- columnas críticas (tenant_id presente?), RLS, count de rows, FK entrantes
WITH t AS (
  SELECT n.nspname, c.relname, c.oid,
         c.relrowsecurity AS rls_enabled,
         c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN (
      'stores','zones','catalogs','daily_captures','daily_assignments',
      'visits','exhibitions','exhibition_photos','valid_exhibition_combinations',
      'scoring_config','scoring_config_versions','scoring_weights',
      'rubric_criteria','rubric_levels'
    )
), cols AS (
  SELECT t.oid, t.relname,
         BOOL_OR(a.attname = 'tenant_id') AS has_tenant_id,
         BOOL_OR(a.attname = 'deleted_at') AS has_deleted_at
  FROM t
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  GROUP BY t.oid, t.relname
), counts AS (
  SELECT t.relname,
         (SELECT COUNT(*) FROM pg_stat_user_tables s WHERE s.relid = t.oid) AS in_pg_stat,
         t.oid
  FROM t
), fks_in AS (
  SELECT t.relname,
         COUNT(*) AS fk_in_count
  FROM t
  LEFT JOIN pg_constraint con ON con.confrelid = t.oid AND con.contype = 'f'
  GROUP BY t.relname
)
SELECT
  t.relname AS table_name,
  COALESCE(cols.has_tenant_id, false) AS has_tenant_id,
  COALESCE(cols.has_deleted_at, false) AS has_deleted_at,
  t.rls_enabled,
  t.rls_forced,
  fks_in.fk_in_count AS fks_pointing_to_this
FROM t
LEFT JOIN cols ON cols.oid = t.oid
LEFT JOIN fks_in ON fks_in.relname = t.relname
ORDER BY t.relname;
