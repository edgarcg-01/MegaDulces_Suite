/* eslint-disable no-console */
/**
 * Diff schema entre DB Railway (prod) y DB local nueva (multi-tenant).
 *
 * Compara:
 *   - Schemas (namespaces postgres)
 *   - Tablas (qualified schema.table)
 *   - Migraciones aplicadas (knex_migrations)
 *
 * READ-ONLY. No modifica nada en ninguna DB. Producirá un reporte que el
 * usuario debe revisar antes de aplicar migraciones a Railway.
 *
 * Uso: node database/diff-railway-vs-local.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const RAILWAY_URL = 'postgresql://postgres:GlUiaSQzybfoPyTtvouBBoqbfxgUUTPZ@switchback.proxy.rlwy.net:16885/railway';
const LOCAL_CFG = require('../knexfile-newdb.js').development.connection;

(async () => {
  const railway = new Client({ connectionString: RAILWAY_URL, ssl: { rejectUnauthorized: false } });
  const local = new Client(LOCAL_CFG);

  console.log('── Conectando ──');
  try { await railway.connect(); console.log('✓ Railway OK'); }
  catch (e) { console.error('✗ Railway FAIL:', e.message); process.exit(1); }
  try { await local.connect(); console.log('✓ Local OK'); }
  catch (e) { console.error('✗ Local FAIL:', e.message); process.exit(1); }

  // ── Schemas ─────────────────────────────────────────────────────────────
  const schemasQ = `
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast','pg_temp_1','pg_toast_temp_1')
    ORDER BY schema_name
  `;
  const r1 = await railway.query(schemasQ);
  const l1 = await local.query(schemasQ);
  console.log('\n── Schemas ──');
  console.log('Railway:', r1.rows.map(r => r.schema_name).join(', '));
  console.log('Local:  ', l1.rows.map(r => r.schema_name).join(', '));

  const railwaySchemas = new Set(r1.rows.map(r => r.schema_name));
  const localSchemas = new Set(l1.rows.map(r => r.schema_name));
  const schemasFaltan = [...localSchemas].filter(s => !railwaySchemas.has(s));
  if (schemasFaltan.length) {
    console.log('🚨 SCHEMAS QUE FALTAN EN RAILWAY:', schemasFaltan.join(', '));
  }

  // ── Tablas ──────────────────────────────────────────────────────────────
  const tablesQ = `
    SELECT table_schema || '.' || table_name AS qualified, table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
      AND table_type = 'BASE TABLE'
    ORDER BY qualified
  `;
  const r2 = await railway.query(tablesQ);
  const l2 = await local.query(tablesQ);
  const railwayTables = new Set(r2.rows.map(r => r.qualified));
  const localTables = new Set(l2.rows.map(r => r.qualified));

  console.log(`\n── Counts ── Railway: ${railwayTables.size} tablas · Local: ${localTables.size} tablas`);

  const onlyLocal = [...localTables].filter(t => !railwayTables.has(t)).sort();
  const onlyRailway = [...railwayTables].filter(t => !localTables.has(t)).sort();
  const both = [...localTables].filter(t => railwayTables.has(t)).sort();

  console.log(`\n── 🚨 SOLO EN LOCAL (faltan en Railway, hay que crear) [${onlyLocal.length}] ──`);
  for (const t of onlyLocal) console.log('  +', t);

  console.log(`\n── ℹ️ Solo en Railway (legacy, NO tocar) [${onlyRailway.length}] ──`);
  for (const t of onlyRailway.slice(0, 40)) console.log('  -', t);
  if (onlyRailway.length > 40) console.log(`  ... +${onlyRailway.length - 40} más`);

  // ── Columnas: para las tablas en ambas, verificar si cambió el shape ────
  console.log(`\n── Tablas en AMBAS — diff columnas [${both.length}] ──`);
  const columnsQ = `
    SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema || '.' || table_name = $1
    ORDER BY ordinal_position
  `;
  const colDiffs = [];
  for (const t of both) {
    const [rCols, lCols] = await Promise.all([
      railway.query(columnsQ, [t]),
      local.query(columnsQ, [t]),
    ]);
    const rNames = new Set(rCols.rows.map(c => c.column_name));
    const lNames = new Set(lCols.rows.map(c => c.column_name));
    const missing = [...lNames].filter(c => !rNames.has(c));
    const extra = [...rNames].filter(c => !lNames.has(c));
    if (missing.length || extra.length) {
      colDiffs.push({ table: t, missing, extra });
    }
  }
  if (colDiffs.length === 0) {
    console.log('  ✓ Todas las tablas comunes tienen el mismo shape de columnas.');
  } else {
    console.log(`  ⚠️ ${colDiffs.length} tablas con diff de columnas:`);
    for (const d of colDiffs.slice(0, 20)) {
      console.log(`    · ${d.table}`);
      if (d.missing.length) console.log(`        + Faltan en Railway: ${d.missing.join(', ')}`);
      if (d.extra.length) console.log(`        - Extras en Railway: ${d.extra.join(', ')}`);
    }
    if (colDiffs.length > 20) console.log(`    ... +${colDiffs.length - 20} más`);
  }

  // ── Migraciones ─────────────────────────────────────────────────────────
  const migQ = `SELECT name, batch FROM knex_migrations ORDER BY id`;

  console.log('\n── Knex migrations ──');
  let railwayMigs = [];
  try {
    const r = await railway.query(migQ);
    railwayMigs = r.rows.map(x => x.name);
    console.log(`Railway: ${railwayMigs.length} aplicadas (última: ${railwayMigs[railwayMigs.length - 1] || 'NINGUNA'})`);
  } catch (e) {
    console.log('Railway: tabla knex_migrations NO existe → DB sin Knex migrations system');
  }

  let localMigs = [];
  try {
    const r = await local.query(migQ);
    localMigs = r.rows.map(x => x.name);
    console.log(`Local:   ${localMigs.length} aplicadas (última: ${localMigs[localMigs.length - 1] || 'NINGUNA'})`);
  } catch (e) {
    console.log('Local: tabla knex_migrations NO existe (raro)');
  }

  const railwayMigSet = new Set(railwayMigs);
  const migsFaltan = localMigs.filter(m => !railwayMigSet.has(m));
  console.log(`\n── 🚨 MIGRACIONES LOCAL no aplicadas en Railway [${migsFaltan.length}] ──`);
  for (const m of migsFaltan) console.log('  +', m);

  const migsExtra = railwayMigs.filter(m => !localMigs.includes(m));
  if (migsExtra.length) {
    console.log(`\n── ⚠️ MIGRACIONES en Railway que NO existen en local [${migsExtra.length}] ──`);
    for (const m of migsExtra) console.log('  -', m);
  }

  console.log('\n──────────────────────── RESUMEN ────────────────────────');
  console.log(`Schemas faltantes en Railway: ${schemasFaltan.length}`);
  console.log(`Tablas faltantes en Railway: ${onlyLocal.length}`);
  console.log(`Tablas con diff de columnas: ${colDiffs.length}`);
  console.log(`Migraciones faltan aplicar: ${migsFaltan.length}`);
  console.log(`Migraciones extra en Railway: ${migsExtra.length}`);

  await railway.end();
  await local.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
