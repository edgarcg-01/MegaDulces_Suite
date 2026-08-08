/* eslint-disable no-console */
/**
 * Proyecto Tienda — TICKETS EN VIVO de Wincaja, OPCIÓN C (copia-sombra + extractor
 * incremental). Lee SOLO los tickets nuevos de una COPIA del .mdb (la que deja SyncBack
 * cada pocos min, NO el archivo vivo del POS) vía Jet 32-bit read-only, y los empuja al
 * mismo `POST /store/live/ingest` (upsert idempotente + WS /store → /tienda/live).
 *
 * Por qué copia-sombra: NUNCA se abre el .mdb que la caja está escribiendo → cero riesgo
 * de lock/corrupción en producción. SyncBack copia el .mdb vivo (open-file copy) a un
 * staging local en esta máquina; este proceso lee esa copia.
 *
 * Flujo por tienda y ciclo:
 *   1) extract-query.ps1 (32-bit, Mode=Read) sobre la copia:
 *        maestro:  SELECT ... FROM MaestroMovAlmacen  WHERE Tipo='V' AND Fecha >= #fecha#
 *        detalles: SELECT ... FROM DetallesMovAlmacen d JOIN MaestroMovAlmacen m ...
 *   2) arma tickets, descarta cancelados y consecutivo <= watermark
 *   3) POST al ingest (idempotente por warehouse_code+serie+folio → reenvío inofensivo)
 *   4) avanza watermark (max consecutivo) en archivo de estado
 *
 * FRESCURA = cadencia de SyncBack (cada N min copia el .mdb) + POLL_MIN de este proceso.
 * Con SyncBack a 5 min y POLL_MIN=5 → tickets en vivo ~5-10 min. El pipeline pesado
 * diario (sync-wincaja-actual) sigue aparte para analítica; esto NO lo toca.
 *
 * Config (env):
 *   WINCAJA_LIVE_MDBS = JSON [{code,mdb,warehouse_code,name}] rutas de las COPIAS-sombra.
 *                       Default: staging local ./_shadow/<code>.mdb para 30/32/50.
 *   STORE_INGEST_URL  = https://<api-prod>/api/store/live/ingest
 *   STORE_INGEST_KEY  = <clave> (match API)
 *   POLL_MINUTES      = 5
 *   LOOKBACK_DAYS     = 2   (ventana de Fecha en el 1er ciclo / sin watermark)
 *   WH_CODE_MODE      = warehouse_code | source_branch  (debe matchear el JWT del encargado)
 *
 *   & powershell ... (este proceso corre con node normal; él invoca el PS 32-bit)
 *   node database/importers/wincaja/wincaja-live-extract.js --dry    # 1 ciclo, no empuja
 *   node database/importers/wincaja/wincaja-live-extract.js --once   # 1 ciclo real y sale (Task Scheduler c/5min) ← recomendado
 *   node database/importers/wincaja/wincaja-live-extract.js          # loop interno (proceso largo)
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const PS32 = process.env.PS32 || 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const EXTRACT = path.join(__dirname, 'extract-query.ps1');
const INGEST_URL = process.env.STORE_INGEST_URL || 'http://localhost:3000/api/store/live/ingest';
const INGEST_KEY = process.env.STORE_INGEST_KEY || 'dev_store_ingest_key';
const POLL_MS = (Number(process.env.POLL_MINUTES) || 5) * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS) || 2;
const WH_CODE_MODE = process.env.WH_CODE_MODE === 'source_branch' ? 'source_branch' : 'warehouse_code';
const DRY = process.argv.includes('--dry');
const ONCE = process.argv.includes('--once'); // 1 ciclo real y sale (para Task Scheduler c/5min)
const STATE_FILE = path.join(__dirname, '.wincaja-live-extract.json');

// Rutas de las COPIAS-sombra en Z: (= \\192.168.0.245\D, las deja SyncBack). Default =
// las MISMAS rutas que ya usa el import diario en .249 (verificado 2026-08). Override:
//   WINCAJA_LIVE_MDBS_FILE = ruta a un .json con el array (recomendado para Task Scheduler
//     — evita el infierno de escapar JSON+backslashes en env),  o
//   WINCAJA_LIVE_MDBS      = el array JSON inline (usar barras normales '/' en las rutas).
const MDB_BASE = process.env.WINCAJA_MDB_BASE || 'Z:/Salidas/Bases/Actuales';
const STORES = (() => {
  if (process.env.WINCAJA_LIVE_MDBS_FILE) return JSON.parse(fs.readFileSync(process.env.WINCAJA_LIVE_MDBS_FILE, 'utf8'));
  if (process.env.WINCAJA_LIVE_MDBS) return JSON.parse(process.env.WINCAJA_LIVE_MDBS);
  return [
    { code: '30', mdb: `${MDB_BASE}/30 MORELIA ABASTOS.MDB`, warehouse_code: 'MD-30', name: 'Morelia Abastos' },
    { code: '32', mdb: `${MDB_BASE}/32 MORELIA MADERO.MDB`, warehouse_code: 'MD-32', name: 'Morelia Madero' },
    { code: '50', mdb: `${MDB_BASE}/50 CANINDO.MDB`, warehouse_code: 'MD-50', name: 'Canindo' },
  ];
})();

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) { console.warn('watermark no guardado:', e.message); } };
const asInt = (v) => { const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };
// Jet quiere fechas en #M/D/YYYY# (US). ISO 'YYYY-MM-DD' → '#M/D/YYYY#'.
const jetDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `#${m}/${d}/${y}#`; };

/** Corre extract-query.ps1 (32-bit) y devuelve el array de filas parseadas del JSONL. */
function runQuery(mdb, query) {
  const out = path.join(os.tmpdir(), `wclive_${Date.now()}_${Math.round(process.hrtime()[1] % 1e6)}.jsonl`);
  const res = spawnSync(PS32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXTRACT, '-Mdb', mdb, '-Query', query, '-Out', out], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`extract-query falló: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  let rows = [];
  try {
    const txt = fs.readFileSync(out, 'utf8');
    rows = txt.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } finally { try { fs.unlinkSync(out); } catch { /* noop */ } }
  return rows;
}

/** Lee tickets nuevos de la copia-sombra de una tienda. */
function fetchNew(store, wm) {
  if (!fs.existsSync(store.mdb)) { console.warn(`  ⚠️ ${store.code}: no existe la copia ${store.mdb} — ¿SyncBack ya copió?`); return { tickets: [], maxCons: wm?.consecutivo || 0 }; }
  const since = wm?.fecha_iso || (() => { const d = new Date(); d.setDate(d.getDate() - LOOKBACK_DAYS); return d.toISOString().slice(0, 10); })();
  const sinceCons = wm?.consecutivo || 0;
  const jd = jetDate(since);

  const heads = runQuery(store.mdb,
    `SELECT Consecutivo, Documento, Fecha, Hora, Caja, Cajero, Cancelado FROM MaestroMovAlmacen WHERE Tipo='V' AND Fecha >= ${jd}`);
  const lines = runQuery(store.mdb,
    `SELECT d.Consecutivo, d.Articulo, d.CantidadRegular, d.ValorVenta FROM DetallesMovAlmacen AS d INNER JOIN MaestroMovAlmacen AS m ON d.Consecutivo = m.Consecutivo WHERE m.Tipo='V' AND m.Fecha >= ${jd}`);

  const byCons = new Map();
  for (const l of lines) {
    const k = String(l.Consecutivo);
    const arr = byCons.get(k) || [];
    arr.push({ sku: String(l.Articulo || ''), nombre: '', cant: Number(l.CantidadRegular) || 0, importe: Number(l.ValorVenta) || 0 });
    byCons.set(k, arr);
  }

  const whCode = WH_CODE_MODE === 'source_branch' ? store.code : store.warehouse_code;
  let maxCons = sinceCons;
  const tickets = [];
  for (const h of heads) {
    if (h.Cancelado === true || h.Cancelado === 1) continue;
    const consInt = asInt(h.Consecutivo);
    if (consInt <= sinceCons) continue;                  // ya empujado
    if (consInt > maxCons) maxCons = consInt;
    const items = byCons.get(String(h.Consecutivo)) || [];
    const total = items.reduce((a, it) => a + it.importe, 0);
    // Fecha 'YYYY-MM-DDTHH:MM:SS' (solo fecha) + Hora (timestamp 1899, se toma la hora).
    const dateP = String(h.Fecha || '').slice(0, 10);
    const timeP = (String(h.Hora || '').match(/T(\d{2}:\d{2}:\d{2})/) || [])[1] || '00:00:00';
    tickets.push({
      warehouse_code: whCode, warehouse_name: store.name,
      serie: 'WC', folio: String(h.Consecutivo),
      ticket_ts: `${dateP}T${timeP}-06:00`,
      total, forma_pago: null, cajero: h.Cajero != null ? String(h.Cajero) : null,
      items,
    });
  }
  tickets.sort((a, b) => asInt(a.folio) - asInt(b.folio));
  return { tickets, maxCons, sinceIso: since };
}

async function push(tickets) {
  if (!tickets.length) return { inserted: 0 };
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-ingest-key': INGEST_KEY },
    body: JSON.stringify({ tickets, emit: true }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

async function cycle(state) {
  let total = 0;
  for (const store of STORES) {
    try {
      const wm = state[store.code] || {};
      const { tickets, maxCons, sinceIso } = fetchNew(store, wm);
      if (!tickets.length) continue;
      total += tickets.length;
      if (DRY) {
        console.log(`  [DRY] ${store.code}: ${tickets.length} nuevos (ej. folio ${tickets[0].folio} ts ${tickets[0].ticket_ts} $${Math.round(tickets[0].total)})`);
      } else {
        const r = await push(tickets);
        state[store.code] = { fecha_iso: sinceIso, consecutivo: maxCons };
        saveState(state);
        console.log(`  ${store.code}: +${tickets.length} → ingest (inserted ${r.inserted ?? '?'})`);
      }
    } catch (e) { console.warn(`  ⚠️ ${store.code}: ${e.message}`); }
  }
  return total;
}

(async () => {
  console.log(`\n=== WINCAJA live extract (Opción C, ${DRY ? 'DRY 1 ciclo' : 'loop'}) ===`);
  console.log(`  ingest: ${INGEST_URL}  · tiendas: ${STORES.map((s) => s.code).join(',')}  · poll: ${POLL_MS / 60000}min  · wh_code: ${WH_CODE_MODE}`);
  const state = loadState();
  if (DRY) { const n = await cycle(state); console.log(`\n[DRY] ${n} tickets nuevos (nada empujado).`); return; }
  if (ONCE) { const n = await cycle(state); console.log(`\n[ONCE] ${n} tickets empujados. Salgo.`); return; }
  const tick = async () => { try { const n = await cycle(state); if (n) console.log(`  ciclo: ${n} tickets.`); } catch (e) { console.error('ciclo falló:', e.message); } };
  await tick();
  setInterval(tick, POLL_MS);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
