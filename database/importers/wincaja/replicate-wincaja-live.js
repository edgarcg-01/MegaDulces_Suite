'use strict';
/**
 * Fase WR.3 + WR.4 — RÉPLICA CRUDA CONTINUA de las bases Wincaja (Access 97 → Postgres).
 * Hermano de `replicate-ods-live.js` (Kepler), pero con Jet como reader (Access no tiene
 * replicación lógica). Espeja TODAS las tablas de cada .mdb a la DB `wincaja` @ :5433,
 * schema por sucursal, en dos carriles:
 *
 *   CARRIL INCREMENTAL (movimientos append-only, monótonos): MaestroMovAlmacen, DetallesMovAlmacen,
 *     PagosDia, Arqueos, Cortes, Retiros. Lee `WHERE <wm_col> > watermark` (barato, acotado).
 *     Watermark en `ods.wincaja_watermark`.
 *
 *   CARRIL HASH-DELTA (catálogos + ledgers mutables): Articulos, Precios, Existencias, Clientes,
 *     MovimientoClientes/Proveedores… Full-scan → md5(fila) en JS → UPSERT solo si el hash cambió
 *     (WHERE _row_hash IS DISTINCT FROM excluded._row_hash → cero churn en filas iguales).
 *
 * Conflict target (access-mirror.conflictTarget): PK natural → DO UPDATE; sin PK → UNIQUE(_row_hash)
 * surrogate → DO NOTHING (movimientos inmutables).
 *
 * On-prem only (Jet 32-bit + Z:). NO en Railway.
 *
 * Uso:
 *   node replicate-wincaja-live.js --branch=30 --dry           # 1 pasada, no escribe (muestra plan)
 *   node replicate-wincaja-live.js --branch=30 --once          # 1 pasada real y sale
 *   node replicate-wincaja-live.js --once                      # 1 pasada, todas las sucursales
 *   node replicate-wincaja-live.js --watch=5                   # loop cada 5 min (proceso largo)
 *   node replicate-wincaja-live.js --branch=30 --only=Articulos,Precios --once   # subset de tablas
 */
const path = require('path');
const { Client } = require('pg');
const A = require(path.join(__dirname, '..', 'lib', 'access-adapter'));
const { conflictTarget, dataColumns, HK_HASH } = require(path.join(__dirname, '..', 'lib', 'access-mirror'));
const { BRANCHES, REPLICA_URL, watermarkCol } = require('./wincaja-replica-config');

const DRY = process.argv.includes('--dry');
const ONCE = process.argv.includes('--once');
const branchArg = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1];
const watchArg = (process.argv.find((a) => a.startsWith('--watch=')) || '').split('=')[1];
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
// Carril a procesar: inc = solo movimientos (watermark, barato → frescura alta) · hash = solo
// catálogos (full-scan, caro → cadencia baja) · all = ambos (default). Base del split WR.5.1.
const CARRIL = ((process.argv.find((a) => a.startsWith('--carril=')) || '').split('=')[1] || 'all').toLowerCase();
const WATCH_MS = watchArg ? Number(watchArg) * 60 * 1000 : 0;
const BATCH = Number(process.env.WINCAJA_UPSERT_BATCH) || 500;

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const schemaCache = new Map();

async function ensureState(c) {
  await c.query('CREATE SCHEMA IF NOT EXISTS ods');
  await c.query(`CREATE TABLE IF NOT EXISTS ods.wincaja_watermark (
    schema_name text, table_name text, wm_col text,
    wm_value text, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (schema_name, table_name))`);
}

async function getWatermark(c, schema, table) {
  const r = await c.query('SELECT wm_value FROM ods.wincaja_watermark WHERE schema_name=$1 AND table_name=$2', [schema, table]);
  return r.rowCount ? r.rows[0].wm_value : null;
}
async function setWatermark(c, schema, table, col, value) {
  await c.query(`INSERT INTO ods.wincaja_watermark (schema_name, table_name, wm_col, wm_value, updated_at)
    VALUES ($1,$2,$3,$4, now())
    ON CONFLICT (schema_name, table_name) DO UPDATE SET wm_col=excluded.wm_col, wm_value=excluded.wm_value, updated_at=now()`,
    [schema, table, col, String(value)]);
}

/** Descubre (y cachea) el esquema de una sucursal, uniendo sus archivos (.mdb base + MOV). */
function branchSchema(b) {
  if (schemaCache.has(b.code)) return schemaCache.get(b.code);
  const files = [b.mdb, b.mov].filter(Boolean);
  const seen = new Map();
  for (const f of files) {
    let sc;
    try { sc = A.discoverSchema(f, { noCounts: true }); }
    catch (e) { console.warn(`  ⚠️ esquema ${path.basename(f)}: ${e.message}`); continue; }
    for (const t of sc) if (t.columns.length && !seen.has(t.table)) seen.set(t.table, { ...t, _file: f });
  }
  const arr = [...seen.values()];
  schemaCache.set(b.code, arr);
  return arr;
}

/** Construye el SQL de UPSERT para una tabla (según su conflict target). */
function buildUpsert(schema, table, cols, conflict) {
  const insertCols = [...cols, HK_HASH];
  const surrogate = conflict.length === 1 && conflict[0] === HK_HASH;
  const colList = insertCols.map(q).join(', ');
  const ph = (rowIdx) => '(' + insertCols.map((_, j) => `$${rowIdx * insertCols.length + j + 1}`).join(', ') + ')';
  const conflictList = conflict.map(q).join(', ');
  let tail;
  if (surrogate) {
    tail = `ON CONFLICT (${conflictList}) DO NOTHING`;
  } else {
    const setList = [...cols.map((cName) => `${q(cName)}=excluded.${q(cName)}`), `${q(HK_HASH)}=excluded.${q(HK_HASH)}`, '_synced_at=now()'].join(', ');
    tail = `ON CONFLICT (${conflictList}) DO UPDATE SET ${setList} WHERE ${q(schema)}.${q(table)}.${q(HK_HASH)} IS DISTINCT FROM excluded.${q(HK_HASH)}`;
  }
  return { head: `INSERT INTO ${q(schema)}.${q(table)} (${colList}) VALUES `, tail, insertCols, ph };
}

/** UPSERT en lotes. Devuelve filas afectadas (rowCount acumulado). */
async function upsertRows(c, schema, table, cols, conflict, rows) {
  if (!rows.length) return 0;
  const { head, tail, insertCols, ph } = buildUpsert(schema, table, cols, conflict);
  let affected = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    slice.forEach((row, r) => {
      values.push(ph(r));
      for (const cName of cols) { let v = row[cName]; if (v === undefined) v = null; params.push(v); }
      params.push(A.rowHash(pick(row, cols)));
    });
    const res = await c.query(head + values.join(', ') + ' ' + tail, params);
    affected += res.rowCount || 0;
  }
  return affected;
}

function pick(row, cols) { const o = {}; for (const c of cols) o[c] = row[c] === undefined ? null : row[c]; return o; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** Sincroniza una tabla (elige carril). Devuelve {carril, read, wrote}. */
async function syncTable(c, b, t) {
  const cols = dataColumns(t);
  const conflict = conflictTarget(t);
  const wmCol = watermarkCol(t.table);
  const file = t._file || b.mdb;

  if (wmCol) {
    // INCREMENTAL
    const wm = await getWatermark(c, b.schema, t.table);
    const rows = A.readIncremental(file, t.table, { sinceCol: wmCol, sinceVal: wm == null ? 0 : toNum(wm) });
    if (DRY) return { carril: `inc(${wmCol}>${wm ?? 0})`, read: rows.length, wrote: 0 };
    const wrote = await upsertRows(c, b.schema, t.table, cols, conflict, rows);
    if (rows.length) {
      const maxWm = rows.reduce((m, r) => Math.max(m, toNum(r[wmCol])), wm == null ? 0 : toNum(wm));
      await setWatermark(c, b.schema, t.table, wmCol, maxWm);
    }
    return { carril: `inc(${wmCol})`, read: rows.length, wrote };
  }
  // HASH-DELTA (full-scan)
  const rows = A.readTable(file, t.table);
  if (DRY) return { carril: 'hash', read: rows.length, wrote: 0 };
  const wrote = await upsertRows(c, b.schema, t.table, cols, conflict, rows);
  return { carril: 'hash', read: rows.length, wrote };
}

async function syncBranch(c, b) {
  const tables = branchSchema(b)
    .filter((t) => !ONLY || ONLY.has(t.table))
    .filter((t) => CARRIL === 'all' || (CARRIL === 'inc' ? !!watermarkCol(t.table) : !watermarkCol(t.table)));
  console.log(`\n=== ${b.code} ${b.name} → ${b.schema} (${tables.length} tablas${ONLY ? ' [filtro]' : ''}${CARRIL !== 'all' ? ' carril=' + CARRIL : ''}) ===`);
  const t0 = Date.now();
  let totRead = 0, totWrote = 0, incN = 0, hashN = 0;
  for (const t of tables) {
    try {
      const r = await syncTable(c, b, t);
      totRead += r.read; totWrote += r.wrote;
      if (r.carril.startsWith('inc')) incN++; else hashN++;
      if (r.read || r.wrote) console.log(`  ${t.table.padEnd(28)} ${r.carril.padEnd(16)} read=${String(r.read).padStart(7)} wrote=${String(r.wrote).padStart(7)}`);
    } catch (e) { console.warn(`  ⚠️ ${t.table}: ${e.message}`); }
  }
  console.log(`  → ${incN} inc / ${hashN} hash · read ${totRead} · wrote ${totWrote} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { totRead, totWrote };
}

async function cycle() {
  const list = branchArg ? BRANCHES.filter((b) => b.code === branchArg) : BRANCHES;
  const c = new Client({ connectionString: REPLICA_URL, statement_timeout: 120000 });
  await c.connect();
  try {
    if (!DRY) await ensureState(c);
    for (const b of list) { if (b.mdb) await syncBranch(c, b); }
  } finally { await c.end(); }
}

(async () => {
  const mode = DRY ? 'DRY' : WATCH_MS ? `WATCH ${WATCH_MS / 60000}min` : ONCE ? 'ONCE' : 'ONCE (default)';
  console.log(`=== WR.3 réplica cruda Wincaja (${mode}) · batch ${BATCH} ===`);
  await cycle();
  if (WATCH_MS && !DRY) {
    console.log(`\n(loop cada ${WATCH_MS / 60000} min — Ctrl+C para salir)`);
    setInterval(() => { cycle().catch((e) => console.error('ciclo falló:', e.message)); }, WATCH_MS);
  } else {
    console.log('\nlisto.');
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
