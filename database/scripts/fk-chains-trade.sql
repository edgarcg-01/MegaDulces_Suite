-- FK chains entre tablas trade marketing
SELECT
  src_n.nspname || '.' || src.relname AS src_table,
  dst_n.nspname || '.' || dst.relname AS dst_table,
  c.conname AS constraint_name
FROM pg_constraint c
JOIN pg_class src ON src.oid = c.conrelid
JOIN pg_namespace src_n ON src_n.oid = src.relnamespace
JOIN pg_class dst ON dst.oid = c.confrelid
JOIN pg_namespace dst_n ON dst_n.oid = dst.relnamespace
WHERE c.contype = 'f'
  AND (
    src.relname IN ('stores','zones','catalogs','daily_captures','daily_assignments',
                    'visits','exhibitions','exhibition_photos','valid_exhibition_combinations',
                    'scoring_config','scoring_config_versions','scoring_weights',
                    'rubric_criteria','rubric_levels')
    OR
    dst.relname IN ('stores','zones','catalogs','daily_captures','daily_assignments',
                    'visits','exhibitions','exhibition_photos','valid_exhibition_combinations',
                    'scoring_config','scoring_config_versions','scoring_weights',
                    'rubric_criteria','rubric_levels')
  )
ORDER BY dst_n.nspname, dst.relname, src.relname;
