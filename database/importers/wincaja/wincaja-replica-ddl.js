'use strict';
/**
 * Fase WR.2 — crea el destino de la réplica cruda Wincaja y AUTO-GENERA el DDL espejo.
 *   1) asegura la DB centralizada `wincaja` @ :5433 (CREATE DATABASE si falta).
 *   2) por sucursal: CREATE SCHEMA wXX + un CREATE TABLE espejo por cada tabla del .mdb
 *      (tipos vía access-mirror.jetToPg, PK natural o UNIQUE(_row_hash)).
 *
 * On-prem (Jet 32-bit + Z: viven en la máquina de feeds). NO en Railway.
 *
 * Uso:
 *   node database/importers/wincaja/wincaja-replica-ddl.js --branch=30 --dry     # imprime el DDL
 *   node database/importers/wincaja/wincaja-replica-ddl.js --branch=30 --apply   # crea DB+schema+tablas
 *   node database/importers/wincaja/wincaja-replica-ddl.js --apply                # todas las sucursales
 */
const path = require('path');
const { Client } = require('pg');
const A = require(path.join(__dirname, '..', 'lib', 'access-adapter'));
const { mirrorDDL, conflictTarget } = require(path.join(__dirname, '..', 'lib', 'access-mirror'));
const { BRANCHES, REPLICA_URL, ADMIN_URL, watermarkCol } = require('./wincaja-replica-config');

const DRY = process.argv.includes('--dry');
const APPLY = process.argv.includes('--apply');
const branchArg = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1];

async function ensureDatabase() {
  const c = new Client({ connectionString: ADMIN_URL, statement_timeout: 30000 });
  await c.connect();
  try {
    const r = await c.query("SELECT 1 FROM pg_database WHERE datname='wincaja'");
    if (r.rowCount) { console.log('  DB wincaja: ya existe'); return; }
    if (APPLY) { await c.query('CREATE DATABASE wincaja'); console.log('  DB wincaja: ✓ CREATE DATABASE'); }
    else console.log('  DB wincaja: (falta — se crearía con --apply)');
  } finally { await c.end(); }
}

/** Descubre el esquema de todos los archivos de la sucursal y devuelve tablas únicas con estructura. */
function discoverBranch(b) {
  const files = [b.mdb, b.mov].filter(Boolean);
  const seen = new Map();
  for (const f of files) {
    let sc;
    try { sc = A.discoverSchema(f, { noCounts: true }); }
    catch (e) { console.warn(`  ⚠️ no pude leer ${path.basename(f)}: ${e.message}`); continue; }
    for (const t of sc) { if (t.columns.length && !seen.has(t.table)) seen.set(t.table, t); }
  }
  return [...seen.values()];
}

async function ddlBranch(b) {
  console.log(`\n=== ${b.code} ${b.name} → schema ${b.schema} ===`);
  const tables = discoverBranch(b);
  const ddls = tables.map((t) => ({ t, sql: mirrorDDL(b.schema, t) })).filter((x) => x.sql);
  const inc = tables.filter((t) => watermarkCol(t.table)).length;
  console.log(`  ${ddls.length} tablas con estructura (${inc} incremental / ${ddls.length - inc} hash-delta)`);

  if (DRY) {
    console.log(`\nCREATE SCHEMA IF NOT EXISTS "${b.schema}";\n`);
    for (const { t, sql } of ddls.slice(0, 4)) {
      console.log(`-- carril=${watermarkCol(t.table) ? 'incremental(' + watermarkCol(t.table) + ')' : 'hash-delta'}  conflict=[${conflictTarget(t).join(',')}]`);
      console.log(sql, '\n');
    }
    console.log(`... (${ddls.length - 4} tablas más con el mismo patrón)`);
    return;
  }
  if (APPLY) {
    const c = new Client({ connectionString: REPLICA_URL, statement_timeout: 60000 });
    await c.connect();
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS "${b.schema}"`);
      let n = 0;
      for (const { t, sql } of ddls) { try { await c.query(sql); n++; } catch (e) { console.warn(`  ⚠️ ${t.table}: ${e.message}`); } }
      console.log(`  ✓ ${n}/${ddls.length} tablas espejo en ${b.schema}`);
    } finally { await c.end(); }
  }
}

(async () => {
  const mode = DRY ? 'DRY' : APPLY ? 'APPLY' : 'sin acción (usa --dry o --apply)';
  console.log(`=== WR.2 DDL espejo Wincaja (${mode}) ===`);
  await ensureDatabase();
  if (!DRY && !APPLY) return;
  const list = branchArg ? BRANCHES.filter((b) => b.code === branchArg) : BRANCHES;
  if (!list.length) { console.log(`  (sin sucursal ${branchArg})`); return; }
  for (const b of list) await ddlBranch(b);
  console.log('\nlisto.');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
