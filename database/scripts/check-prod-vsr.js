"use strict";

/**
 * READ-ONLY: constraints/indexes/RLS de commercial.vendor_sales_routes en prod,
 * para entender por qué un INSERT (assign) no persistió.
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/check-prod-vsr.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rel = `'commercial.vendor_sales_routes'::regclass`;

  const cons = await c.query(`
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = ${rel} ORDER BY contype`);
  console.log('CONSTRAINTS:');
  for (const r of cons.rows) console.log(`  [${r.contype}] ${r.conname}: ${r.def}`);

  const idx = await c.query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='commercial' AND tablename='vendor_sales_routes'`);
  console.log('\nINDEXES:');
  for (const r of idx.rows) console.log(`  ${r.indexname}: ${r.indexdef}`);

  const rls = await c.query(`
    SELECT relrowsecurity AS rls_on, relforcerowsecurity AS rls_forced
    FROM pg_class WHERE oid = ${rel}`);
  console.log('\nRLS:', rls.rows[0]);

  const pol = await c.query(`
    SELECT polname, polcmd,
           pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS withcheck_expr
    FROM pg_policy WHERE polrelid = ${rel}`);
  console.log('\nPOLICIES:');
  for (const r of pol.rows) console.log(`  ${r.polname} [cmd=${r.polcmd}] USING=${r.using_expr} CHECK=${r.withcheck_expr}`);

  // columnas NOT NULL relevantes
  const cols = await c.query(`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='commercial' AND table_name='vendor_sales_routes'
    ORDER BY ordinal_position`);
  console.log('\nCOLUMNS:');
  for (const r of cols.rows) console.log(`  ${r.column_name} nullable=${r.is_nullable} default=${r.column_default || '-'}`);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
