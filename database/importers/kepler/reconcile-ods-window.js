/* eslint-disable no-console */
/**
 * CDC.7 — RED DE SEGURIDAD del CDC: reconcilia la VENTANA RECIENTE de las tablas de movimiento
 * entre cada replica local (:5433/kepler_md_XX) y `kepler_ods` en prod, y **repone lo que falte**.
 *
 * POR QUÉ EXISTE
 * --------------
 * El CDC por WAL (`ods-cdc-wal.js`, ADR-047) reemplazó al poll (`replicate-ods-live.js`) y con él se
 * fue la única cosa que sanaba huecos: la ventana de re-envío por fecha de negocio (`ODS_SAFETY_DAYS`).
 * Un stream de WAL no tiene reintento posible hacia atrás: si el slot muere y se recrea —lo que pasa
 * cuando `wal_status` llega a `lost` por el cap `max_slot_wal_keep_size`— todo lo ocurrido en ese
 * hueco **no vuelve nunca**. Y no hay señal: los sensores miden frescura (`max(fecha)`), así que un
 * agujero en el medio con datos frescos alrededor es invisible.
 *
 * Lo vivimos el 2026-08-31: 285 renglones de `kdm2` en 74 documentos, con la cabecera presente y el
 * detalle ausente. La pantalla lo mostraba como "su único renglón es de servicio" (una factura de
 * $4,518 con 3 renglones reales) y lo detectó un humano, no un sensor.
 *
 * QUÉ HACE
 * --------
 * Por sucursal × tabla: compara el conjunto de LLAVES PRIMARIAS de la ventana reciente (local vs ODS
 * de prod), lee del replica sólo las filas ausentes y las shipea por `raw-upsert` (idempotente, mismo
 * camino que el CDC). No borra nada, no toca el CDC, no lee el POS. Ship = sólo el delta real.
 *
 * La ventana se acota por la FECHA DE NEGOCIO de cada tabla (`RECENT_COL`), no por `c9` en todas:
 * `c9` es fecha sólo en `kdm1`; en `kdm2` es CANTIDAD. Misma tabla de columnas que usaba la red de
 * seguridad vieja, ya verificada (kdm2.c32 ≡ fecha del header en 99.999% de las filas).
 *
 * Uso:
 *   node reconcile-ods-window.js                       # dry-run, 3 días, todas las sucursales
 *   node reconcile-ods-window.js --days=10 --apply     # repone
 *   node reconcile-ods-window.js --branch=06 --tables=kdm2 --days=15 --apply
 *
 * Env: ODS_SOURCE_BASE (base :5433) · DATABASE_URL_NEW (destino prod, sólo para LEER las llaves)
 *      FEEDS_SINK=http + FEEDS_INGEST_URL + FEEDS_INGEST_KEY (el ship, igual que el CDC)
 */

const { Client } = require('pg');
const sink = require('../lib/sink');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const DAYS = Math.max(1, Number(arg('days', 3)));
const ONLY_BRANCH = arg('branch', null);
const TABLES = String(arg('tables', 'kdm1,kdm2,kdij,kdue,kdpord')).split(',').map((s) => s.trim()).filter(Boolean);
const SHIP_BATCH = Math.max(200, Number(process.env.ODS_SHIP_BATCH) || 2000);

// Fecha de NEGOCIO por tabla. Una tabla sin entrada acá no se puede acotar → se salta (reconciliar
// una tabla entera por PK sería carísimo y no es el objetivo de una red de seguridad).
const RECENT_COL = { kdm1: 'c9', kdm2: 'c32', kdpord: 'c6', kdue: 'c7', kdij: 'c10' };

const SUB_BASE = process.env.ODS_SOURCE_BASE
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };
const BRANCH_CODES = (ONLY_BRANCH ? [ONLY_BRANCH] : (process.env.ODS_LIVE_BRANCHES || '00,01,02,03,04,05,06').split(','))
  .map((s) => s.trim()).filter(Boolean);

const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const mapType = (dt) => ({
  numeric: 'numeric', 'double precision': 'double precision', real: 'real', integer: 'integer',
  bigint: 'bigint', smallint: 'smallint', boolean: 'boolean', date: 'date',
  'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
}[dt] || 'text');

/** Columnas + PK de md.<table> en el replica. */
async function tableMeta(src, table) {
  const cols = (await src.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='md' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
  if (!cols.length) return null;
  const pk = (await src.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
    WHERE i.indrelid=('md.'||$1)::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`, [table])).rows.map((r) => r.attname);
  return { cols, pk };
}

const keyOf = (pk, row) => pk.map((k) => String(row[k] ?? '\x00')).join('|');

async function reconcile(local, prod, code, table) {
  const rcol = RECENT_COL[table];
  if (!rcol) return { suc: code, tabla: table, skip: 'sin columna de fecha de negocio' };
  const meta = await tableMeta(local, table);
  if (!meta) return { suc: code, tabla: table, skip: 'no existe en el replica' };
  if (!meta.pk.length) return { suc: code, tabla: table, skip: 'sin PK' };

  const pkList = meta.pk.map(qid).join(', ');
  const ventana = `${qid(rcol)} >= (current_date - ${DAYS})`;

  const loc = (await local.query(`SELECT ${pkList} FROM md.${qid(table)} WHERE ${ventana}`)).rows;
  if (!loc.length) return { suc: code, tabla: table, local: 0, faltan: 0 };

  // El ODS es multi-sucursal: SIEMPRE filtrar por `sucursal`, o se compara contra las 7 ramas.
  const pro = (await prod.query(
    `SELECT ${pkList} FROM kepler_ods.${qid(table)} WHERE btrim(sucursal)=$1 AND ${ventana}`, [code])).rows;
  const presentes = new Set(pro.map((r) => keyOf(meta.pk, r)));
  const faltan = loc.filter((r) => !presentes.has(keyOf(meta.pk, r)));
  if (!faltan.length) return { suc: code, tabla: table, local: loc.length, faltan: 0 };
  if (!APPLY) return { suc: code, tabla: table, local: loc.length, faltan: faltan.length, dry: true };

  // Releer las filas COMPLETAS de las llaves ausentes y shipearlas por el camino del CDC.
  const selList = meta.cols.map((c) => qid(c.column_name)).join(', ');
  const shipMeta = { table, pk: meta.pk, columns: [{ name: 'sucursal', type: 'text' }, ...meta.cols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }))] };
  let enviadas = 0;
  for (let i = 0; i < faltan.length; i += SHIP_BATCH) {
    const chunk = faltan.slice(i, i + SHIP_BATCH);
    const binds = chunk.flatMap((r) => meta.pk.map((k) => r[k]));
    const ph = `(${pkList}) IN (${chunk.map((_, ix) => `(${meta.pk.map((__, j) => `$${ix * meta.pk.length + j + 1}`).join(',')})`).join(',')})`;
    const full = (await local.query(`SELECT ${selList} FROM md.${qid(table)} WHERE ${ph}`, binds)).rows;
    const rows = full.map((row) => { const o = { sucursal: code }; for (const c of meta.cols) o[c.column_name] = row[c.column_name]; return o; });
    if (rows.length) { await sink.ship('raw-upsert', { rows, tenantId: TENANT, meta: shipMeta }); enviadas += rows.length; }
  }
  return { suc: code, tabla: table, local: loc.length, faltan: faltan.length, enviadas };
}

(async () => {
  const destUrl = process.env.DATABASE_URL_NEW;
  if (!destUrl) { console.error('Falta DATABASE_URL_NEW (se lee para comparar las llaves del ODS).'); process.exit(2); }
  const prod = new Client({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, statement_timeout: 600000 });
  await prod.connect();
  console.log(`reconcile-ods-window · ventana ${DAYS}d · tablas ${TABLES.join(',')} · ${APPLY ? 'APPLY' : 'dry-run'}\n`);
  const out = [];
  for (const code of BRANCH_CODES) {
    const local = new Client({ connectionString: localUrl(code), statement_timeout: 600000 });
    try { await local.connect(); } catch (e) { out.push({ suc: code, skip: `replica no conecta: ${e.message.slice(0, 40)}` }); continue; }
    for (const t of TABLES) {
      try { out.push(await reconcile(local, prod, code, t)); }
      catch (e) { out.push({ suc: code, tabla: t, error: e.message.slice(0, 80) }); }
    }
    await local.end().catch(() => {});
  }
  await prod.end().catch(() => {});
  console.table(out);
  const huecos = out.reduce((a, r) => a + (r.faltan || 0), 0);
  console.log(`\nfilas ausentes en el ODS: ${huecos}${APPLY ? ` · repuestas: ${out.reduce((a, r) => a + (r.enviadas || 0), 0)}` : ' (dry-run: nada se envió)'}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
