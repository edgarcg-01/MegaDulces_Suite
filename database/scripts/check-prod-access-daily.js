"use strict";

/**
 * READ-ONLY: ¿puede app_runtime (RLS) leer public.daily_assignments y public.catalogs?
 * Define si el modo vendedor puede leerlas directo desde tk.run.
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/check-prod-access-daily.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const TABLES = ['daily_assignments', 'catalogs'];

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  for (const t of TABLES) {
    const rel = `'public.${t}'::regclass`;
    const kind = await c.query(`SELECT relkind, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = ${rel}`);
    const grants = await c.query(`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name=$1 AND grantee='app_runtime'`, [t]);
    const hasTenant = await c.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name='tenant_id'`, [t]);
    const pol = await c.query(`
      SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
      FROM pg_policy WHERE polrelid = ${rel}`);
    console.log(`\n=== public.${t} ===`);
    console.log(`  relkind=${kind.rows[0].relkind} (r=tabla, v=vista) rls=${kind.rows[0].rls} forced=${kind.rows[0].forced} tenant_id=${hasTenant.rows.length > 0}`);
    console.log(`  grants app_runtime: ${grants.rows.map((r) => r.privilege_type).join(', ') || '(NINGUNO)'}`);
    for (const p of pol.rows) console.log(`  policy ${p.polname} [${p.polcmd}] USING=${p.using_expr}`);
  }

  // ¿catalogs es vista? si lo es, ver su definición resumida
  const isView = await c.query(`SELECT relkind FROM pg_class WHERE oid='public.catalogs'::regclass`);
  if (isView.rows[0].relkind === 'v') {
    const def = await c.query(`SELECT pg_get_viewdef('public.catalogs'::regclass) AS def`);
    console.log('\ncatalogs VIEW def:', def.rows[0].def.slice(0, 300));
  }

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
