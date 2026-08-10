/* eslint-disable no-console */
/**
 * Fase SYNC · W.1 — EXISTENCIA viva de Wincaja → commercial.stock, vía feeds-ingest.
 *
 * Opción C (node en .249): lee la tabla `Existencias` de la COPIA-sombra .mdb de cada
 * sucursal (Jet 32-bit read-only vía extract-query.ps1), calcula la existencia por SKU,
 * hace snapshot-diff local por sucursal y empuja SOLO el delta al handler `wincaja-stock`
 * (lib/sink.js). Hermano de wincaja-live-extract.js (tickets); separado a propósito porque
 * el watermark de stock es snapshot-diff, no por consecutivo.
 *
 * Existencia Wincaja = ExistenciaInicialRegular + EntradaRegular − SalidaRegular
 *   (misma derivación que import-wincaja.js → wincaja.existencias → v_stock).
 * Se agrega por Articulo (sku) sumando los Almacen internos de la sucursal (= v_stock).
 * warehouse_code (destino commercial.warehouses.code): MD-30/MD-32/MD-50, '00' CEDIS.
 *
 * Push: mismo patrón que import-branch-stock-live.js — un qty=0 es "poner en 0" (drop);
 * NO se borra el resto del almacén (el handler es upsert-delta, no snapshot).
 *
 * Env (además de los de STORES, ver wincaja-live-extract.js):
 *   FEEDS_SINK=http · FEEDS_INGEST_URL=https://feeds-ingest-... · FEEDS_INGEST_KEY=...
 *   (FEEDS_SINK=pg → escribe directo con DATABASE_URL_NEW, fallback histórico)
 *   WINCAJA_STOCK_MDBS_FILE / WINCAJA_STOCK_MDBS — override del array de sucursales.
 *
 *   node database/importers/wincaja/wincaja-stock-extract.js --dry    # 1 ciclo, no empuja
 *   node database/importers/wincaja/wincaja-stock-extract.js --once   # 1 ciclo real y sale (Task Scheduler)
 *   node database/importers/wincaja/wincaja-stock-extract.js          # loop
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const sink = require('../lib/sink');

const PS32 = process.env.PS32 || 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const EXTRACT = path.join(__dirname, 'extract-query.ps1');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const POLL_MS = (Number(process.env.STOCK_POLL_MINUTES) || 10) * 60 * 1000;
const DRY = process.argv.includes('--dry');
const ONCE = process.argv.includes('--once');
const STATE_DIR = __dirname;

// Copias-sombra .mdb (mismas rutas que el extractor de tickets). Default 30/32/50; el CEDIS '00'
// (Irapuato) se agrega vía WINCAJA_STOCK_MDBS_FILE con su .mdb + warehouse_code '00'.
const MDB_BASE = process.env.WINCAJA_MDB_BASE || 'Z:/Staging/Live';
const STORES = (() => {
  if (process.env.WINCAJA_STOCK_MDBS_FILE) return JSON.parse(fs.readFileSync(process.env.WINCAJA_STOCK_MDBS_FILE, 'utf8'));
  if (process.env.WINCAJA_STOCK_MDBS) return JSON.parse(process.env.WINCAJA_STOCK_MDBS);
  return [
    { code: '30', mdb: `${MDB_BASE}/30 MORELIA ABASTOS.MDB`, warehouse_code: 'MD-30', name: 'Morelia Abastos' },
    { code: '32', mdb: `${MDB_BASE}/32 MORELIA MADERO.MDB`, warehouse_code: 'MD-32', name: 'Morelia Madero' },
    { code: '50', mdb: `${MDB_BASE}/50 CANINDO.MDB`, warehouse_code: 'MD-50', name: 'Canindo' },
  ];
})();

const snapPath = (code) => path.join(STATE_DIR, `.wincaja-stock-${code}.json`);
const loadSnap = (code) => { try { return JSON.parse(fs.readFileSync(snapPath(code), 'utf8')); } catch { return {}; } };
const saveSnap = (code, obj) => { try { fs.writeFileSync(snapPath(code), JSON.stringify(obj)); } catch (e) { console.warn(`snapshot ${code} no guardado:`, e.message); } };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Corre extract-query.ps1 (32-bit) y devuelve el array de filas del JSONL. */
function runQuery(mdb, query) {
  const out = path.join(os.tmpdir(), `wcstk_${process.pid}_${Math.round(process.hrtime()[1] % 1e6)}.jsonl`);
  const res = spawnSync(PS32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXTRACT, '-Mdb', mdb, '-Query', query, '-Out', out], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`extract-query falló: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  try {
    return fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } finally { try { fs.unlinkSync(out); } catch { /* noop */ } }
}

/** Existencia deseada por SKU de una sucursal (agrega Almacenes internos). */
function readDesired(store) {
  if (!fs.existsSync(store.mdb)) { console.warn(`  ⚠️ ${store.code}: no existe ${store.mdb} — ¿SyncBack ya copió?`); return null; }
  const rows = runQuery(store.mdb,
    'SELECT Almacen, Articulo, ExistenciaInicialRegular, EntradaRegular, SalidaRegular FROM Existencias');
  const desired = new Map();
  for (const r of rows) {
    const sku = String(r.Articulo || '').trim();
    if (!sku) continue;
    const ex = num(r.ExistenciaInicialRegular) + num(r.EntradaRegular) - num(r.SalidaRegular);
    desired.set(sku, (desired.get(sku) || 0) + ex);
  }
  return desired;
}

/** Delta contra el snapshot local: SKUs con qty distinta + drops (estaban y ya no) → 0. */
function diff(desired, snap) {
  const changed = [];
  for (const [sku, qty] of desired) if (num(snap[sku]) !== qty) changed.push({ sku, existencia: qty });
  for (const sku of Object.keys(snap)) if (!desired.has(sku) && num(snap[sku]) !== 0) changed.push({ sku, existencia: 0 });
  return changed;
}

async function cycle(pgClient) {
  let total = 0;
  for (const store of STORES) {
    try {
      const desired = readDesired(store);
      if (!desired) continue;
      const snap = loadSnap(store.code);
      const changed = diff(desired, snap);
      if (!changed.length) continue;
      total += changed.length;
      if (DRY) {
        console.log(`  [DRY] ${store.code} (${store.warehouse_code}): ${changed.length} SKUs cambiados de ${desired.size} vivos (ej. ${changed[0].sku}=${changed[0].existencia})`);
      } else {
        const r = await sink.ship('wincaja-stock', { rows: changed, tenantId: TENANT, meta: { warehouse_code: store.warehouse_code }, client: pgClient });
        // snapshot = estado deseado completo (los drops quedan fuera → quedan en 0 en DB)
        saveSnap(store.code, Object.fromEntries(desired));
        console.log(`  ${store.code} (${store.warehouse_code}): +${changed.length} → wincaja-stock (${r.mode}, filas ${r.rowCount}${r.ms != null ? `, ${r.ms}ms` : ''})`);
      }
    } catch (e) { console.warn(`  ⚠️ ${store.code}: ${e.message}`); }
  }
  return total;
}

(async () => {
  console.log(`\n=== WINCAJA stock extract (existencia → wincaja-stock, ${DRY ? 'DRY' : sink.sinkMode()}) ===`);
  console.log(`  sucursales: ${STORES.map((s) => `${s.code}→${s.warehouse_code}`).join(', ')}  · poll: ${POLL_MS / 60000}min`);
  // Modo pg (fallback): abrir un Client a DATABASE_URL_NEW; en http no se necesita DB.
  let pgClient = null;
  if (!DRY && sink.sinkMode() === 'pg') {
    const { Client } = require('pg');
    const cs = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
    const ssl = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(cs) ? false : { rejectUnauthorized: false };
    pgClient = new Client({ connectionString: cs, ssl });
    await pgClient.connect();
  }
  try {
    if (DRY) { const n = await cycle(pgClient); console.log(`\n[DRY] ${n} cambios detectados (nada empujado, snapshots intactos).`); return; }
    if (ONCE) { const n = await cycle(pgClient); console.log(`\n[ONCE] ${n} cambios empujados. Salgo.`); return; }
    const tick = async () => { try { const n = await cycle(pgClient); if (n) console.log(`  ciclo: ${n} cambios.`); } catch (e) { console.error('ciclo falló:', e.message); } };
    await tick();
    await new Promise((resolve) => { setInterval(tick, POLL_MS); process.on('SIGINT', resolve).on('SIGTERM', resolve); });
  } finally { if (pgClient) await pgClient.end().catch(() => {}); }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
