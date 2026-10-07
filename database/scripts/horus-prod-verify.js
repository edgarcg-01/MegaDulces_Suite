"use strict";
/**
 * READ-ONLY — verifica el deploy de Horus en prod + diagnostica el 25P02.
 * Uso: PROD_DATABASE_URL='postgresql://...' node database/scripts/horus-prod-verify.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (label, sql, params) => {
    try { const r = await c.query(sql, params); return r.rows; }
    catch (e) { console.log(`  [${label}] ERROR: ${e.message}`); return null; }
  };

  console.log('=== search_path ===');
  const sp = await q('search_path', 'SHOW search_path');
  console.log('  ', sp && sp[0].search_path);

  console.log('\n=== migraciones Horus en knex_migrations ===');
  const migs = await q('migs',
    `SELECT name FROM knex_migrations WHERE name LIKE '2026061%horus%' OR name LIKE '20260616150000%' OR name LIKE '%supervisor%' OR name LIKE '%execution%' OR name LIKE '%capture_vision%' OR name LIKE '%findings_source%' OR name LIKE '%actions_v2%' OR name LIKE '%coaching%' ORDER BY name`);
  (migs || []).forEach((m) => console.log('  ✓', m.name));
  if (migs && migs.length === 0) console.log('  (NINGUNA migración Horus registrada)');

  console.log('\n=== commercial.* tablas de Horus presentes ===');
  const tbls = await q('tbls',
    `SELECT table_name FROM information_schema.tables WHERE table_schema='commercial' AND table_name IN ('execution_360','execution_thresholds','supervisor_findings','supervisor_actions','coaching_notes','supervisor_tasks','capture_vision') ORDER BY table_name`);
  (tbls || []).forEach((t) => console.log('  ✓', t.table_name));

  console.log('\n=== execution_360: columnas nuevas (H2.3/H2.1) ===');
  const cols = await q('cols',
    `SELECT column_name FROM information_schema.columns WHERE table_schema='commercial' AND table_name='execution_360' AND column_name IN ('exec_score','exec_score_breakdown','exec_level_score','avg_visit_min','avg_skus') ORDER BY column_name`);
  console.log('  ', (cols || []).map((x) => x.column_name).join(', ') || '(ninguna)');

  console.log('\n=== supervisor_actions: columnas kind/rationale + CHECK action_type ===');
  const acols = await q('acols',
    `SELECT column_name FROM information_schema.columns WHERE table_schema='commercial' AND table_name='supervisor_actions' AND column_name IN ('kind','rationale')`);
  console.log('   cols:', (acols || []).map((x) => x.column_name).join(', ') || '(ninguna)');
  const chk = await q('chk',
    `SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='chk_supervisor_actions_type'`);
  console.log('   CHECK:', (chk && chk[0] && chk[0].def) || '(no existe)');

  console.log('\n=== SOSPECHOSOS del 25P02: ¿se pueden consultar? ===');
  const cp = await q('catalog.products', 'SELECT count(*)::int n FROM catalog.products');
  console.log('   catalog.products:', cp ? `OK (${cp[0].n} rows)` : 'FALLA');
  const cat = await q('catalogs (sin calificar)', 'SELECT count(*)::int n FROM catalogs');
  console.log('   catalogs (unqualified):', cat ? `OK (${cat[0].n} rows)` : 'FALLA ← probable causa');
  const tcat = await q('trade.catalogs', 'SELECT count(*)::int n FROM trade.catalogs');
  console.log('   trade.catalogs:', tcat ? `OK (${tcat[0].n} rows)` : 'FALLA');

  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
