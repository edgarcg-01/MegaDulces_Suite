"use strict";

/**
 * Diff de esquema LOCAL (nueva DB) vs PROD (Railway). SOLO LECTURA:
 * lee information_schema + public.knex_migrations, no ejecuta DDL/DML.
 *
 * Uso (PowerShell):
 *   $env:PROD_DATABASE_URL='postgresql://...'; node database/scripts/schema-diff-prod.js
 *
 * LOCAL sale de DATABASE_URL_NEW (.env). PROD de PROD_DATABASE_URL (env, no se
 * persiste en disco para no filtrar credenciales).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const LOCAL_URL = process.env.DATABASE_URL_NEW;
const PROD_URL = process.env.PROD_DATABASE_URL;

if (!LOCAL_URL) { console.error('Falta DATABASE_URL_NEW (local) en .env'); process.exit(1); }
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL en el entorno'); process.exit(1); }

const mask = (u) => u.replace(/:[^:@/]+@/, ':****@');

async function introspect(url, useSsl) {
  const client = new Client({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false });
  await client.connect();
  const rels = await client.query(`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY 1,2`);
  const cols = await client.query(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY 1,2,ordinal_position`);
  let migrations = [];
  try {
    const m = await client.query(`SELECT name FROM public.knex_migrations ORDER BY id`);
    migrations = m.rows.map((r) => r.name);
  } catch { /* sin knex_migrations en public */ }
  await client.end();

  const relMap = new Map();
  for (const r of rels.rows) relMap.set(`${r.table_schema}.${r.table_name}`, r.table_type);
  const colMap = new Map();
  for (const c of cols.rows) {
    const key = `${c.table_schema}.${c.table_name}`;
    if (!colMap.has(key)) colMap.set(key, new Map());
    colMap.get(key).set(c.column_name, { type: c.data_type, nullable: c.is_nullable });
  }
  return { relMap, colMap, migrations };
}

(async () => {
  console.log('LOCAL:', mask(LOCAL_URL));
  const local = await introspect(LOCAL_URL, false);
  console.log('PROD :', mask(PROD_URL));
  const prod = await introspect(PROD_URL, true);

  const localTables = [...local.relMap.keys()].sort();
  const prodTables = [...prod.relMap.keys()].sort();
  const prodSet = new Set(prodTables);
  const localSet = new Set(localTables);

  const missingInProd = localTables.filter((t) => !prodSet.has(t));
  const extraInProd = prodTables.filter((t) => !localSet.has(t));
  const common = localTables.filter((t) => prodSet.has(t));

  console.log('\n==================================================');
  console.log(`LOCAL: ${localTables.length} relaciones | PROD: ${prodTables.length} relaciones`);
  console.log('==================================================');

  console.log(`\n### EN LOCAL pero NO en PROD  (${missingInProd.length}):`);
  if (!missingInProd.length) console.log('  (ninguna)');
  for (const t of missingInProd) console.log(`  - ${t}  [${local.relMap.get(t)}]`);

  console.log(`\n### EN PROD pero NO en LOCAL  (${extraInProd.length}):`);
  if (!extraInProd.length) console.log('  (ninguna)');
  for (const t of extraInProd) console.log(`  + ${t}  [${prod.relMap.get(t)}]`);

  console.log(`\n### DISCREPANCIAS DE COLUMNAS (en ${common.length} relaciones comunes):`);
  let anyDiff = false;
  for (const t of common) {
    const lc = local.colMap.get(t) || new Map();
    const pc = prod.colMap.get(t) || new Map();
    const missingCols = [...lc.keys()].filter((c) => !pc.has(c));
    const extraCols = [...pc.keys()].filter((c) => !lc.has(c));
    const typeDiffs = [...lc.keys()]
      .filter((c) => pc.has(c) && lc.get(c).type !== pc.get(c).type)
      .map((c) => `${c} (local:${lc.get(c).type} / prod:${pc.get(c).type})`);
    if (missingCols.length || extraCols.length || typeDiffs.length) {
      anyDiff = true;
      console.log(`  • ${t}`);
      if (missingCols.length) console.log(`      cols faltan en prod: ${missingCols.join(', ')}`);
      if (extraCols.length) console.log(`      cols sobran en prod : ${extraCols.join(', ')}`);
      if (typeDiffs.length) console.log(`      tipo distinto       : ${typeDiffs.join(', ')}`);
    }
  }
  if (!anyDiff) console.log('  (sin discrepancias de columnas)');

  const prodMig = new Set(prod.migrations);
  const localMig = new Set(local.migrations);
  const migMissingProd = local.migrations.filter((m) => !prodMig.has(m));
  const migExtraProd = prod.migrations.filter((m) => !localMig.has(m));
  console.log(`\n### MIGRACIONES (public.knex_migrations):`);
  console.log(`  LOCAL: ${local.migrations.length} aplicadas | PROD: ${prod.migrations.length} aplicadas`);
  console.log(`\n  Aplicadas en LOCAL y NO en PROD (${migMissingProd.length}):`);
  if (!migMissingProd.length) console.log('    (ninguna)');
  for (const m of migMissingProd) console.log(`    - ${m}`);
  if (migExtraProd.length) {
    console.log(`\n  Aplicadas en PROD y NO en LOCAL (${migExtraProd.length}):`);
    for (const m of migExtraProd) console.log(`    + ${m}`);
  }
  console.log('\nDONE.');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
