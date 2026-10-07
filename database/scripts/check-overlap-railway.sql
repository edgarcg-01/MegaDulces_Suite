-- Sample IDs from Railway: tables with matching counts to confirm overlap
SELECT 'identity.users' AS tabla, string_agg(id::text, ',' ORDER BY id) AS ids FROM (SELECT id FROM identity.users ORDER BY id LIMIT 5) s
UNION ALL SELECT 'identity.role_permissions', string_agg(id::text, ',' ORDER BY id) FROM (SELECT id FROM identity.role_permissions ORDER BY id LIMIT 5) s
UNION ALL SELECT 'logistics.routes', string_agg(id::text, ',' ORDER BY id) FROM (SELECT id FROM logistics.routes ORDER BY id LIMIT 5) s
UNION ALL SELECT 'logistics.config_finance', string_agg(id::text, ',' ORDER BY id) FROM (SELECT id FROM logistics.config_finance ORDER BY id LIMIT 5) s
UNION ALL SELECT 'logistics.payroll_periods', string_agg(id::text, ',' ORDER BY id) FROM (SELECT id FROM logistics.payroll_periods ORDER BY id LIMIT 5) s
UNION ALL SELECT 'identity.tenants', string_agg(id::text, ',' ORDER BY id) FROM (SELECT id FROM identity.tenants ORDER BY id LIMIT 5) s
;
