CREATE TEMP TABLE tmp_orig_ids (id uuid);
\COPY tmp_orig_ids FROM 'c:/Users/Sistemas/CascadeProjects/Trade_marketing/database/backups/sync-csv/original-1199-product-ids.csv' WITH (FORMAT csv)
SELECT 'total_in_backup' AS scope, COUNT(*) AS n FROM tmp_orig_ids
UNION ALL
SELECT 'id_matches_local', COUNT(*) FROM tmp_orig_ids t WHERE EXISTS(SELECT 1 FROM catalog.products p WHERE p.id = t.id)
UNION ALL
SELECT 'id_NOT_in_local', COUNT(*) FROM tmp_orig_ids t WHERE NOT EXISTS(SELECT 1 FROM catalog.products p WHERE p.id = t.id);
