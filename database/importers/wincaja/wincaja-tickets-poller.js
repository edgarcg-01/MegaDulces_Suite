/* eslint-disable no-console */
/**
 * Proyecto Tienda — POLLER de tickets en vivo de WINCAJA (hermano del de Kepler
 * `kepler/live-tickets-poller.js`). Empuja los tickets de venta de las tiendas
 * solo-Wincaja (30 Morelia Abastos, 32 Morelia Madero, 50 Canindo) al MISMO endpoint
 * de ingest (`POST /store/live/ingest`, header x-store-ingest-key) → upsert idempotente
 * en `analytics.store_live_tickets` + emisión por WebSocket `/store` → `/tienda/live`.
 *
 * FUENTE (importante): NO lee el .mdb del POS directo. Lee la landing YA importada
 * `wincaja.maestro_mov_almacen` (+ detalles) del dataset 'actual'. Corre ON-PREM y lee
 * la DB LOCAL (192.168.0.245) → lecturas gratis; solo el push sale a Railway (ingress
 * gratis). El egress a las sucursales es el delta por WS (bytes).
 *
 *   ⚠️ FRESCURA = cadencia de la fuente. El "vivo" de Wincaja es tan reciente como
 *   (a) el export de los .mdb a Z:\Salidas\Bases\Actuales y (b) la corrida del
 *   import-wincaja.js --dataset actual. Si eso es diario, esto reproduce el batch
 *   diario; si lo corrés cada N minutos, esto se vuelve live sin cambiar código.
 *   Para true-live sub-minuto haría falta lectura near-real-time del .mdb vivo del POS.
 *
 * Idempotente: el ingest ignora duplicados por (warehouse_code, serie, folio), y el
 * poller lleva un watermark por tienda (fecha, consecutivo) en un archivo de estado,
 * así solo empuja tickets NUEVOS aunque el import haga recarga full (mismo fecha/cons
 * = ya visto). Primera corrida: arranca desde max(fecha) − SEED_DAYS para no volcar historia.
 *
 * Env:
 *   STORE_INGEST_URL   = https://<api-prod>/api/store/live/ingest
 *   STORE_INGEST_KEY   = <clave compartida> (match STORE_INGEST_KEY del API)
 *   WINCAJA_LIVE_DB_URL= postgres de lectura (default DATABASE_URL_NEW / local :5433)
 *   POLL_SECONDS       = 60 (opcional)
 *   SEED_DAYS          = 1  (días de historia a incluir en la 1ª corrida)
 *   WINCAJA_LIVE_STORES= "30,32,50" (override opcional)
 *   WH_CODE_MODE       = warehouse_code | source_branch  (qué se emite como warehouse_code;
 *                        debe MATCHEAR el warehouse_code del JWT del encargado para el room WS)
 *
 *   node database/importers/wincaja/wincaja-tickets-poller.js --dry   # 1 ciclo, no empuja
 *   node database/importers/wincaja/wincaja-tickets-poller.js         # loop
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const fs = require('fs');
const { Client } = require('pg');

const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DB_URL = process.env.WINCAJA_LIVE_DB_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const INGEST_URL = process.env.STORE_INGEST_URL || 'http://localhost:3000/api/store/live/ingest';
const INGEST_KEY = process.env.STORE_INGEST_KEY || 'dev_store_ingest_key';
const POLL_MS = (Number(process.env.POLL_SECONDS) || 60) * 1000;
const SEED_DAYS = Number(process.env.SEED_DAYS) || 1;
const STORES = (process.env.WINCAJA_LIVE_STORES || '30,32,50').split(',').map((s) => s.trim()).filter(Boolean);
const WH_CODE_MODE = process.env.WH_CODE_MODE === 'source_branch' ? 'source_branch' : 'warehouse_code';
const DRY = process.argv.includes('--dry');
const STATE_FILE = path.join(__dirname, '.wincaja-live-watermark.json');

const ssl = /rlwy|railway|proxy/i.test(DB_URL) ? { rejectUnauthorized: false } : false;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) { console.warn('no pude guardar watermark:', e.message); }
}
const asInt = (v) => { const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };

/**
 * Trae los tickets NUEVOS (posteriores al watermark) de una tienda. Un ticket =
 * (source_branch, source_dataset='actual', consecutivo). ticket_ts = fecha::date + hora::time
 * en hora local MX (-06). total = Σ valor_venta de las líneas. items = líneas (sku, cant, importe).
 */
async function fetchNewTickets(db, branch, wm) {
  // Semilla: si no hay watermark, arranca desde (max(fecha) - SEED_DAYS).
  let sinceFecha = wm?.fecha || null;
  let sinceCons = wm?.consecutivo || 0;
  if (!sinceFecha) {
    const mx = await db.query(
      `SELECT max(fecha)::date AS f FROM wincaja.maestro_mov_almacen
        WHERE tenant_id=$1 AND source_branch=$2 AND source_dataset='actual' AND tipo='V'`,
      [TENANT, branch],
    );
    const maxF = mx.rows[0]?.f;
    if (!maxF) return { tickets: [], wm };
    const seed = new Date(maxF); seed.setDate(seed.getDate() - SEED_DAYS);
    sinceFecha = seed.toISOString().slice(0, 10);
    sinceCons = 0;
  }

  // Cabeceras nuevas: (fecha > sinceFecha) OR (fecha = sinceFecha AND consecutivo_int > sinceCons).
  const heads = await db.query(
    `SELECT m.consecutivo, m.documento, m.fecha::date AS fecha, m.hora, m.caja, m.cajero,
            to_char((m.fecha::date + COALESCE(NULLIF(split_part(m.hora,'T',2),'')::time, '00:00'::time)), 'YYYY-MM-DD"T"HH24:MI:SS') || '-06:00' AS ticket_ts
       FROM wincaja.maestro_mov_almacen m
      WHERE m.tenant_id=$1 AND m.source_branch=$2 AND m.source_dataset='actual'
        AND m.tipo='V' AND COALESCE(m.cancelado,false)=false
        -- Serie de documento T99 = TRASPASO a otra sucursal (tercero = ALMACEN destino),
        -- NO es venta de mostrador/mayoreo → fuera del monitor live. T98/F70 SÍ son ventas
        -- (mayoreo) y se quedan. (analytics.sales_daily ya excluye T99 por su filtro ALMAC%.)
        AND upper(btrim(m.documento)) NOT LIKE 'T99%'
        AND ( m.fecha::date > $3::date
              OR ( m.fecha::date = $3::date
                   AND COALESCE(NULLIF(regexp_replace(m.consecutivo,'\\D','','g'),'')::bigint,0) > $4 ) )
      ORDER BY m.fecha::date, COALESCE(NULLIF(regexp_replace(m.consecutivo,'\\D','','g'),'')::bigint,0)
      LIMIT 2000`,
    [TENANT, branch, sinceFecha, sinceCons],
  );
  if (!heads.rows.length) return { tickets: [], wm };

  const consList = heads.rows.map((r) => r.consecutivo);
  const lines = await db.query(
    `SELECT d.consecutivo, d.articulo AS sku, d.cantidad_regular AS cant,
            COALESCE(d.valor_venta,0) AS importe
       FROM wincaja.detalles_mov_almacen d
      WHERE d.tenant_id=$1 AND d.source_branch=$2 AND d.source_dataset='actual'
        AND d.consecutivo = ANY($3)`,
    [TENANT, branch, consList],
  );
  const byCons = new Map();
  for (const l of lines.rows) {
    const arr = byCons.get(l.consecutivo) || [];
    arr.push({ sku: String(l.sku || ''), nombre: '', cant: Number(l.cant) || 0, importe: Number(l.importe) || 0 });
    byCons.set(l.consecutivo, arr);
  }

  const whCode = WH_CODE_MODE === 'source_branch' ? branch : (wm?.warehouse_code || branch);
  const tickets = heads.rows.map((h) => {
    const items = byCons.get(h.consecutivo) || [];
    const total = items.reduce((a, it) => a + it.importe, 0);
    return {
      warehouse_code: whCode,
      warehouse_name: wm?.warehouse_name || `Sucursal ${branch}`,
      serie: 'WC',
      folio: String(h.consecutivo),
      ticket_ts: h.ticket_ts,
      total,
      forma_pago: null,
      cajero: h.cajero || null,
      items,
    };
  });
  const last = heads.rows[heads.rows.length - 1];
  const newWm = { ...wm, fecha: last.fecha instanceof Date ? last.fecha.toISOString().slice(0, 10) : String(last.fecha).slice(0, 10), consecutivo: asInt(last.consecutivo) };
  return { tickets, wm: newWm };
}

async function pushTickets(tickets) {
  if (!tickets.length) return { received: 0, inserted: 0 };
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-ingest-key': INGEST_KEY },
    body: JSON.stringify({ tickets, emit: true }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

async function cycle(db, state, whMeta) {
  let totalNew = 0;
  for (const branch of STORES) {
    const wm = { ...(state[branch] || {}), warehouse_code: whMeta[branch]?.warehouse_code, warehouse_name: whMeta[branch]?.branch_name };
    try {
      const { tickets, wm: newWm } = await fetchNewTickets(db, branch, wm);
      if (!tickets.length) continue;
      totalNew += tickets.length;
      if (DRY) {
        console.log(`  [DRY] ${branch}: ${tickets.length} tickets nuevos (ej. folio ${tickets[0].folio} ts ${tickets[0].ticket_ts} $${Math.round(tickets[0].total)})`);
      } else {
        const r = await pushTickets(tickets);
        state[branch] = { fecha: newWm.fecha, consecutivo: newWm.consecutivo };
        saveState(state);
        console.log(`  ${branch}: +${tickets.length} → ingest (inserted ${r.inserted ?? '?'})`);
      }
    } catch (e) {
      console.warn(`  ⚠️ ${branch}: ${e.message}`);
    }
  }
  return totalNew;
}

(async () => {
  console.log(`\n=== WINCAJA live tickets poller (${DRY ? 'DRY 1 ciclo' : 'loop'}) ===`);
  console.log(`  DB: ${DB_URL.replace(/:\/\/[^@]+@/, '://***@')}  · ingest: ${INGEST_URL}  · tiendas: ${STORES.join(',')}  · wh_code: ${WH_CODE_MODE}`);
  const db = new Client({ connectionString: DB_URL, ssl });
  await db.connect();
  // Metadatos de tienda (warehouse_code + nombre) desde el catálogo.
  const b = await db.query(
    `SELECT source_branch, warehouse_code, branch_name FROM wincaja.branches
      WHERE tenant_id=$1 AND source_branch = ANY($2)`,
    [TENANT, STORES],
  );
  const whMeta = Object.fromEntries(b.rows.map((r) => [r.source_branch, r]));
  const state = loadState();

  if (DRY) {
    const n = await cycle(db, state, whMeta);
    console.log(`\n[DRY] ${n} tickets nuevos detectados (nada empujado, watermark intacto).`);
    await db.end();
    return;
  }

  const tick = async () => {
    try { const n = await cycle(db, state, whMeta); if (n) console.log(`  ciclo: ${n} tickets nuevos.`); }
    catch (e) { console.error('ciclo falló:', e.message); }
  };
  await tick();
  setInterval(tick, POLL_MS);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
