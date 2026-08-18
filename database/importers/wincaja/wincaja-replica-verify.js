'use strict';
/**
 * Fase WR.5 — verificación de fidelidad de la réplica cruda Wincaja.
 * Compara, por sucursal y tabla: COUNT(*) en el .mdb (Jet) vs COUNT(*) en el espejo Postgres,
 * y la Σ de un par de columnas de dinero/cantidad para cazar truncados/duplicados.
 *
 * Uso:
 *   node database/importers/wincaja/wincaja-replica-verify.js --branch=30
 *   node database/importers/wincaja/wincaja-replica-verify.js --branch=30 --only=Articulos,DetallesMovAlmacen
 */
const path = require('path');
const { Client } = require('pg');
const A = require(path.join(__dirname, '..', 'lib', 'access-adapter'));
const { BRANCHES, REPLICA_URL } = require('./wincaja-replica-config');

const branchArg = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1];
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// Sumas de control por tabla (columna Access -> se compara Σ redondeada).
const SUMCHECK = {
  DetallesMovAlmacen: 'ValorVenta',
  Existencias: 'Existencia',
  Precios: 'Precio',
};

function mdbCount(file, table) {
  const r = A.query(file, `SELECT COUNT(*) AS n FROM [${table}]`);
  return r[0] ? Number(r[0].n) : 0;
}
function mdbSum(file, table, col) {
  try { const r = A.query(file, `SELECT SUM([${col}]) AS s FROM [${table}]`); return r[0] && r[0].s != null ? Number(r[0].s) : 0; }
  catch { return null; }
}

async function verifyBranch(c, b) {
  console.log(`\n=== ${b.code} ${b.name} (${b.schema}) ===`);
  const files = [b.mdb, b.mov].filter(Boolean);
  const seen = new Map();
  for (const f of files) {
    let sc; try { sc = A.discoverSchema(f, { noCounts: true }); } catch { continue; }
    for (const t of sc) if (t.columns.length && !seen.has(t.table)) seen.set(t.table, f);
  }
  const tables = [...seen.keys()].filter((t) => !ONLY || ONLY.has(t)).sort();
  let okN = 0, badN = 0;
  console.log(`  ${'tabla'.padEnd(28)} ${'mdb'.padStart(9)} ${'espejo'.padStart(9)}  Δ`);
  for (const t of tables) {
    const file = seen.get(t);
    let mc = -1, pc = -1;
    try { mc = mdbCount(file, t); } catch (e) { console.log(`  ${t.padEnd(28)} (mdb error: ${e.message.slice(0, 40)})`); continue; }
    try { const r = await c.query(`SELECT COUNT(*)::int AS n FROM ${q(b.schema)}.${q(t)}`); pc = r.rows[0].n; }
    catch (e) { console.log(`  ${t.padEnd(28)} (espejo error: ${e.message.slice(0, 40)})`); continue; }
    const d = pc - mc;
    const flag = d === 0 ? 'ok' : (d > 0 ? `+${d}` : `${d}`);
    if (d === 0) okN++; else badN++;
    let extra = '';
    if (SUMCHECK[t]) {
      const ms = mdbSum(file, t, SUMCHECK[t]);
      const rs = await c.query(`SELECT COALESCE(SUM((${q(SUMCHECK[t])})::numeric),0) AS s FROM ${q(b.schema)}.${q(t)}`).then((r) => Number(r.rows[0].s)).catch(() => null);
      if (ms != null && rs != null) extra = `  Σ${SUMCHECK[t]}: mdb=${ms.toFixed(2)} espejo=${rs.toFixed(2)} ${Math.abs(ms - rs) < 0.5 ? '✓' : '✗'}`;
    }
    if (d !== 0 || extra) console.log(`  ${t.padEnd(28)} ${String(mc).padStart(9)} ${String(pc).padStart(9)}  ${flag}${extra}`);
  }
  console.log(`  → ${okN} tablas cuadran / ${badN} con delta`);
}

(async () => {
  console.log('=== WR.5 verificación fidelidad Wincaja ===');
  const list = branchArg ? BRANCHES.filter((b) => b.code === branchArg) : BRANCHES;
  const c = new Client({ connectionString: REPLICA_URL, statement_timeout: 120000 });
  await c.connect();
  try { for (const b of list) if (b.mdb) await verifyBranch(c, b); }
  finally { await c.end(); }
  console.log('\nlisto.');
})().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1); });
