/* eslint-disable no-console */
/**
 * Fase SYNC · W.2 — VENTA viva de Wincaja → bronze + sales_daily, vía feeds-ingest.
 *
 * Opción C (node en .249): lee MaestroMovAlmacen + DetallesMovAlmacen (Tipo='V') de la copia
 * .mdb de cada sucursal (Jet 32-bit vía extract-query.ps1), INCREMENTAL por `consecutivo`
 * (watermark local por sucursal), y empuja la venta CRUDA al handler `wincaja-sales-bronze`
 * (lib/sink). El handler escribe bronze y RE-DERIVA analytics.sales_daily con el mismo SQL del
 * gold feed (cero divergencia). El total diario converge a medida que llegan más tickets.
 *
 * Hermano de wincaja-stock-extract.js. NO reimplementa la lógica de canal/unidad/costo: eso vive
 * en el SQL de derivación (server-side).
 *
 *   node database/importers/wincaja/wincaja-sales-extract.js --dry    # 1 ciclo, no empuja
 *   node database/importers/wincaja/wincaja-sales-extract.js --once   # 1 ciclo real y sale
 *   node database/importers/wincaja/wincaja-sales-extract.js          # loop
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
const POLL_MS = (Number(process.env.SALES_POLL_MINUTES) || 5) * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.SALES_LOOKBACK_DAYS) || 2;
const DRY = process.argv.includes('--dry');
const ONCE = process.argv.includes('--once');
// Tipos de documento a extraer. Default 'V' (venta → sales_daily). Para movimientos:
// WINCAJA_SALES_TIPOS='C,E,S,D,I,P,M' (→ stock_movements, misma re-derivación en el handler).
const TIPOS = (process.env.WINCAJA_SALES_TIPOS || 'V').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
for (const t of TIPOS) if (!/^[A-Z]$/.test(t)) throw new Error(`WINCAJA_SALES_TIPOS inválido: ${t}`);
const TIPO_IN = TIPOS.map((t) => `'${t}'`).join(',');
// watermark separado por conjunto de tipos (evita mezclar secuencias V vs no-V).
const STATE_SUFFIX = process.env.WINCAJA_STATE_SUFFIX ? `-${process.env.WINCAJA_STATE_SUFFIX}` : '';
const STATE_FILE = path.join(__dirname, `.wincaja-sales-extract${STATE_SUFFIX}.json`);

const MDB_BASE = process.env.WINCAJA_MDB_BASE || 'Z:/Salidas/Bases/Actuales';
const STORES = (() => {
  if (process.env.WINCAJA_SALES_MDBS_FILE) return JSON.parse(fs.readFileSync(process.env.WINCAJA_SALES_MDBS_FILE, 'utf8'));
  if (process.env.WINCAJA_SALES_MDBS) return JSON.parse(process.env.WINCAJA_SALES_MDBS);
  return [
    { code: '30', mdb: `${MDB_BASE}/30 MORELIA ABASTOS.MDB`, name: 'Morelia Abastos' },
    { code: '32', mdb: `${MDB_BASE}/32 MORELIA MADERO.MDB`, name: 'Morelia Madero' },
    { code: '50', mdb: `${MDB_BASE}/50 CANINDO.MDB`, name: 'Canindo' },
  ];
})();

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) { console.warn('watermark no guardado:', e.message); } };
const asInt = (v) => { const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const jetDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `#${m}/${d}/${y}#`; };
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true');

function runQuery(mdb, query) {
  const out = path.join(os.tmpdir(), `wcsales_${process.pid}_${Math.round(process.hrtime()[1] % 1e6)}.jsonl`);
  const res = spawnSync(PS32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXTRACT, '-Mdb', mdb, '-Query', query, '-Out', out], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`extract-query falló: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  try {
    return fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } finally { try { fs.unlinkSync(out); } catch { /* noop */ } }
}

/** Venta nueva (consecutivo > watermark) de una sucursal → rows etiquetados {k:'m'|'d'}. */
function fetchNew(store, wm) {
  if (!fs.existsSync(store.mdb)) { console.warn(`  ⚠️ ${store.code}: no existe ${store.mdb}`); return null; }
  const sinceCons = asInt(wm && wm.consecutivo);
  const since = (() => { const d = new Date(); d.setDate(d.getDate() - LOOKBACK_DAYS); return d.toISOString().slice(0, 10); })();
  const jd = jetDate(since);

  const heads = runQuery(store.mdb,
    `SELECT Consecutivo, Tipo, Documento, Tercero, Referencia, Fecha, Hora, Almacen, Moneda, Paridad, Caja, Cajero, Vendedor, Cancelado, Observaciones, FechaCaptura FROM MaestroMovAlmacen WHERE Tipo IN (${TIPO_IN}) AND Fecha >= ${jd}`);
  const newHeads = heads.filter((h) => asInt(h.Consecutivo) > sinceCons);
  if (!newHeads.length) return { rows: [], maxCons: sinceCons };

  const lines = runQuery(store.mdb,
    `SELECT d.Consecutivo, d.Articulo, d.Tipo, d.Documento, d.CantidadRegular, d.CantidadAuxiliar, d.ValorCosto, d.ValorVenta, d.IVA, d.IEPS, d.Descuento1, d.Descuento2, d.TipoPrecio, d.UnidadVenta FROM (DetallesMovAlmacen AS d INNER JOIN MaestroMovAlmacen AS m ON d.Consecutivo = m.Consecutivo) WHERE m.Tipo IN (${TIPO_IN}) AND m.Fecha >= ${jd}`);
  const newConsSet = new Set(newHeads.map((h) => String(h.Consecutivo)));
  const linesByCons = new Map();
  for (const l of lines) {
    const c = String(l.Consecutivo);
    if (!newConsSet.has(c)) continue;
    if (!linesByCons.has(c)) linesByCons.set(c, []);
    linesByCons.get(c).push(l);
  }

  const rows = [];
  let maxCons = sinceCons;
  const dateStr = (v) => String(v || '').slice(0, 10) + (String(v || '').includes('T') ? String(v).slice(String(v).indexOf('T'), 19) : '');
  for (const h of newHeads) {
    const c = String(h.Consecutivo);
    const items = linesByCons.get(c) || [];
    if (!items.length) continue; // cabecera sin líneas (doc vacío/en curso) → no representable aún
    maxCons = Math.max(maxCons, asInt(h.Consecutivo));
    rows.push({
      k: 'm', consecutivo: c, tipo: h.Tipo || null, documento: h.Documento || null, tercero: h.Tercero || null,
      referencia: h.Referencia || null, fecha: dateStr(h.Fecha), hora: h.Hora || null, almacen: h.Almacen || null,
      moneda: h.Moneda || null, paridad: h.Paridad != null ? Number(h.Paridad) : null, caja: h.Caja || null,
      cajero: h.Cajero || null, vendedor: h.Vendedor || null, cancelado: bool(h.Cancelado),
      observaciones: h.Observaciones || null, fecha_captura: h.FechaCaptura ? dateStr(h.FechaCaptura) : null,
    });
    for (const l of items) {
      rows.push({
        k: 'd', consecutivo: c, articulo: String(l.Articulo || ''), tipo: l.Tipo || null, documento: l.Documento || null,
        cantidad_regular: l.CantidadRegular != null ? Number(l.CantidadRegular) : null,
        cantidad_auxiliar: l.CantidadAuxiliar != null ? Number(l.CantidadAuxiliar) : null,
        valor_costo: l.ValorCosto != null ? Number(l.ValorCosto) : null, valor_venta: l.ValorVenta != null ? Number(l.ValorVenta) : null,
        iva: l.IVA != null ? Number(l.IVA) : null, ieps: l.IEPS != null ? Number(l.IEPS) : null,
        descuento1: l.Descuento1 != null ? Number(l.Descuento1) : null, descuento2: l.Descuento2 != null ? Number(l.Descuento2) : null,
        tipo_precio: l.TipoPrecio || null, unidad_venta: l.UnidadVenta || null,
      });
    }
  }
  return { rows, maxCons };
}

async function cycle(state) {
  let total = 0;
  for (const store of STORES) {
    try {
      const wm = state[store.code] || {};
      const res = fetchNew(store, wm);
      if (!res || !res.rows.length) continue;
      const heads = res.rows.filter((r) => r.k === 'm').length;
      if (DRY) {
        console.log(`  [DRY] ${store.code}: ${heads} tickets nuevos (${res.rows.length} filas m+d), maxCons ${res.maxCons}`);
        total += heads;
      } else {
        const r = await sink.ship('wincaja-sales-bronze', { rows: res.rows, tenantId: TENANT, meta: { source_branch: store.code, source_dataset: 'actual' } });
        // watermark solo tras push OK (sink lanza en error → reintentable)
        state[store.code] = { consecutivo: res.maxCons };
        saveState(state);
        total += heads;
        console.log(`  ${store.code}: +${heads} tickets → wincaja-sales-bronze (${r.mode}, ${r.rowCount} escrituras${r.ms != null ? `, ${r.ms}ms` : ''})`);
      }
    } catch (e) { console.warn(`  ⚠️ ${store.code}: ${e.message}`); }
  }
  return total;
}

(async () => {
  console.log(`\n=== WINCAJA sales extract (venta → wincaja-sales-bronze, ${DRY ? 'DRY' : sink.sinkMode()}) ===`);
  console.log(`  sucursales: ${STORES.map((s) => s.code).join(', ')}  · tipos: ${TIPOS.join('')}  · poll: ${POLL_MS / 60000}min  · lookback: ${LOOKBACK_DAYS}d`);
  const state = loadState();
  if (DRY) { const n = await cycle(state); console.log(`\n[DRY] ${n} tickets nuevos (nada empujado).`); return; }
  if (ONCE) { const n = await cycle(state); console.log(`\n[ONCE] ${n} tickets empujados. Salgo.`); return; }
  const tick = async () => { try { const n = await cycle(state); if (n) console.log(`  ciclo: ${n} tickets.`); } catch (e) { console.error('ciclo falló:', e.message); } };
  await tick();
  await new Promise((resolve) => { setInterval(tick, POLL_MS); process.on('SIGINT', resolve).on('SIGTERM', resolve); });
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
