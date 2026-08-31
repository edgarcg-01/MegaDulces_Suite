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
const { BRANCHES, REPLICA_URL, watermarkCol, MDB_BASE } = require('./wincaja-replica-config');

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
  const fallas = [];
  for (const f of files) {
    let sc;
    try { sc = A.discoverSchema(f, { noCounts: true }); }
    catch (e) { fallas.push(`${path.basename(f)}: ${e.message}`); continue; }
    for (const t of sc) if (t.columns.length && !seen.has(t.table)) seen.set(t.table, { ...t, _file: f });
  }
  const arr = [...seen.values()];
  // Un descubrimiento VACÍO no es un estado válido: es la fuente inalcanzable (Z: sin montar, .mdb
  // movido). Cachearlo dejó los dos carriles girando en "0 tablas" del 27 al 31 de agosto de 2026
  // sin recuperarse solos al volver la red. Se tira y NO se cachea → el próximo ciclo reintenta.
  if (!arr.length) {
    throw new Error(`esquema vacío para ${b.code}/${b.schema} — fuente inalcanzable`
      + (fallas.length ? `: ${fallas.join(' · ')}` : ` (revisar ${files.join(', ')})`));
  }
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

/**
 * La fuente tiene que existir ANTES de abrir conexiones. Se revisa en CADA ciclo (no una sola vez
 * al arrancar) para que el proceso se cure solo cuando el share vuelve, sin reiniciar PM2.
 */
function preflightSource() {
  if (require('fs').existsSync(MDB_BASE)) return;
  const drive = /^([A-Za-z]):/.exec(MDB_BASE);
  if (drive) {
    console.error(`  "${drive[1]}:" es una unidad MAPEADA, y los mapeos de Windows son POR SESIÓN`);
    console.error('  de login: un servicio o una tarea como SYSTEM puede no verla nunca. Preferí una');
    console.error('  ruta UNC (\\\\servidor\\share\\...) en WINCAJA_MDB_BASE — no depende de la sesión.');
  }
  throw new Error(`WINCAJA_MDB_BASE inalcanzable: ${MDB_BASE}`);
}

async function cycle() {
  const list = branchArg ? BRANCHES.filter((b) => b.code === branchArg) : BRANCHES;
  preflightSource();
  const c = new Client({ connectionString: REPLICA_URL, statement_timeout: 120000 });
  await c.connect();
  const fallas = [];
  try {
    if (!DRY) await ensureState(c);
    // Una sucursal caída NO debe tapar a las otras: se registra y se sigue con las que sí responden.
    for (const b of list) {
      if (!b.mdb) continue;
      try { await syncBranch(c, b); }
      catch (e) { fallas.push(`${b.code}: ${e.message}`); console.error(`  ✖ ${b.code} ${b.name}: ${e.message}`); }
    }
  } finally { await c.end(); }
  if (fallas.length) throw new Error(`${fallas.length}/${list.length} sucursales fallaron — ${fallas.join(' · ')}`);
}

(async () => {
  const mode = DRY ? 'DRY' : WATCH_MS ? `WATCH ${WATCH_MS / 60000}min` : ONCE ? 'ONCE' : 'ONCE (default)';
  console.log(`=== WR.3 réplica cruda Wincaja (${mode}) · batch ${BATCH} ===`);
  // El vigilante no puede fallar en silencio: sin destino para el heartbeat, un feed muerto es
  // indistinguible de uno sano — PM2 sigue diciendo "online". Pasó del 27 al 31 de agosto de 2026:
  // 4 días en cero con los dos carriles "online" y el heartbeat abortando por falta de esta var.
  // En watch (desatendido) se aborta el arranque antes que correr a ciegas.
  if (WATCH_MS && !DRY && !process.env.DATABASE_URL_NEW && !process.env.DATABASE_URL) {
    console.error('✖ falta DATABASE_URL_NEW/DATABASE_URL: el heartbeat no podría reportar a cron_runs.');
    console.error('  Exportala antes de "pm2 start" — el ecosystem la pasa explícita. Abortando.');
    process.exit(1);
  }
  // Heartbeat SOLO en modo watch (proceso largo bajo PM2, reemplaza el wrapper PS1/Task Scheduler).
  // Keyed por carril → FeedGuardian/db-health ve cada carril con su propio umbral (inc ~2min / hash ~1h).
  const hb = (WATCH_MS && !DRY) ? require('../lib/cron-heartbeat') : null;
  const HB_KEY = `wincaja_replica_${CARRIL}`;
  const runCycle = async () => {
    if (hb) await hb.begin(HB_KEY, `Wincaja réplica cruda (${CARRIL})`).catch(() => {});
    try {
      await cycle();
      if (hb) await hb.end(HB_KEY, { status: 'ok' }).catch(() => {});
    } catch (e) {
      if (hb) await hb.end(HB_KEY, { status: 'error', error: e.message }).catch(() => {});
      throw e;
    }
  };
  // En watch, un primer ciclo fallido NO debe matar el proceso: PM2 quemaría sus max_restarts en
  // minutos y quedaría "errored". Se reporta (el heartbeat ya registró el error) y se entra al loop,
  // que reintenta — y como el esquema vacío ya no se cachea, se cura solo cuando la fuente vuelve.
  try { await runCycle(); }
  catch (e) {
    if (!WATCH_MS || DRY) throw e;
    console.error('primer ciclo falló:', e.message);
  }
  if (WATCH_MS && !DRY) {
    console.log(`\n(loop cada ${WATCH_MS / 60000} min — Ctrl+C para salir)`);
    setInterval(() => { runCycle().catch((e) => console.error('ciclo falló:', e.message)); }, WATCH_MS);
  } else {
    console.log('\nlisto.');
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
