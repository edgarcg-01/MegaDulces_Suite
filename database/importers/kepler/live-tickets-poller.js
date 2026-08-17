/* eslint-disable no-console */
/**
 * Proyecto Tienda (TDA.1) — POLLER de tickets en vivo. Proceso ON-PREM de larga
 * duración: cada ~25s lee de las 6 sucursales los tickets de VENTA (c4=10) de una
 * ventana deslizante (últimos ~5 min) con su canasta (kdm2), y los EMPUJA al API de
 * prod (`POST /store/live/ingest`, header x-store-ingest-key). El ingest es
 * idempotente (upsert), así que el solape de ventana no duplica; solo los nuevos se
 * emiten por WebSocket (/store). Único punto de polling del pipeline (runner→Kepler).
 *
 * Env:
 *   STORE_INGEST_URL   = https://<api-prod>/api/store/live/ingest
 *   STORE_INGEST_KEY   = <clave compartida> (match STORE_INGEST_KEY del API)
 *   POLL_SECONDS       = 25 (opcional)  ·  WINDOW_MINUTES = 5 (opcional)
 *   SALES_BRANCH_MAP   = JSON opcional para override de sucursales
 *
 *   node database/importers/kepler/live-tickets-poller.js
 */
const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const INGEST_URL = process.env.STORE_INGEST_URL || 'http://localhost:3000/api/store/live/ingest';
const INGEST_KEY = process.env.STORE_INGEST_KEY || 'dev_store_ingest_key';
const POLL_MS = (Number(process.env.POLL_SECONDS) || 25) * 1000;
const WINDOW_MIN = Number(process.env.WINDOW_MINUTES) || 5;
// --dry: lee y arma tickets pero NO empuja al API; corre 1 ciclo y sale (verificación).
const DRY = process.argv.includes('--dry');

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { salesMap } = require('../lib/kepler-branches');
const BRANCHES = process.env.SALES_BRANCH_MAP ? JSON.parse(process.env.SALES_BRANCH_MAP) : salesMap();

// Canindo (06) migró de Wincaja a Kepler; su POS (192.168.50.50:1977) NO tiene platform_ro
// → NO está en kepler-branches.js. Se lee del REPLICA LÓGICO LOCAL `kepler_md_06` (mismo md.*
// schema, sin carga al POS, sin cred nueva) vía DATABASE_URL_NEW del .env. Si no hay replica
// local disponible (o URL inválida), se omite → 01-05 no se afectan.
if (process.env.DATABASE_URL_NEW && !BRANCHES.some((b) => b.code === '06')) {
  try {
    const u = new URL(process.env.DATABASE_URL_NEW); u.pathname = '/kepler_md_06';
    BRANCHES.push({ code: '06', name: 'Canindo', db: 'kepler_md_06', url: u.toString() });
  } catch { /* URL inválida → omitir 06 */ }
}

const pad = (n) => String(n).padStart(2, '0');
// "YYYY-MM-DD HH:MM" en hora local MX (offset fijo -06, Centro sin DST).
function sinceLocalMX(minutesAgo) {
  const nowMx = new Date(Date.now() - 6 * 3600 * 1000 - minutesAgo * 60 * 1000);
  return `${nowMx.getUTCFullYear()}-${pad(nowMx.getUTCMonth() + 1)}-${pad(nowMx.getUTCDate())} ${pad(nowMx.getUTCHours())}:${pad(nowMx.getUTCMinutes())}`;
}
// Inicio del día de HOY en hora local MX ("YYYY-MM-DD 00:00") — para el backfill.
function startOfTodayMX() {
  const nowMx = new Date(Date.now() - 6 * 3600 * 1000);
  return `${nowMx.getUTCFullYear()}-${pad(nowMx.getUTCMonth() + 1)}-${pad(nowMx.getUTCDate())} 00:00`;
}

async function pollBranch(b, since) {
  // 06 (Canindo) trae `url` = replica local; 01-05 usan su POS remoto (platform_ro).
  const c = b.url
    ? new Client({ connectionString: b.url, connectionTimeoutMillis: 6000, statement_timeout: 30000 })
    : new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 6000, statement_timeout: 30000 });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT h.c6 folio, rtrim(btrim(h.c63),'-') serie, h.c9::date fecha, h.c62 hora, h.c5 caja,
              coalesce(h.c16,0) total, h.c10 forma_pago, btrim(h.c67) cajero,
              d.c8 sku, d.c10 nombre, coalesce(d.c9,0) cant, coalesce(d.c13,0) importe, d.c7 linea
         FROM md.kdm1 h
         JOIN md.kdm2 d ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
        WHERE h.c2='U' AND h.c3='D' AND h.c4=10
          AND h.c62 ~ '^[0-9]{1,2}:[0-9]{2}'
          AND (h.c9::date + h.c62::time) >= $1::timestamp
          AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
        ORDER BY h.c9, h.c62, h.c6, d.c7`, [since]);

    const byTicket = new Map();
    for (const r of rows) {
      const key = `${r.serie}|${r.folio}`;
      let t = byTicket.get(key);
      if (!t) {
        const fecha = r.fecha.toISOString().slice(0, 10);
        t = {
          warehouse_code: b.code, warehouse_name: b.name, serie: r.serie, folio: r.folio,
          ticket_ts: `${fecha}T${r.hora.length === 4 ? '0' + r.hora : r.hora}:00-06:00`,
          total: Number(r.total) || 0, forma_pago: r.forma_pago, cajero: r.cajero || null,
          caja: r.caja != null ? String(r.caja).trim() : null, items: [],
        };
        byTicket.set(key, t);
      }
      t.items.push({ sku: r.sku, nombre: r.nombre, cant: Number(r.cant) || 0, importe: Number(r.importe) || 0 });
    }
    return [...byTicket.values()];
  } finally { await c.end().catch(() => {}); }
}

const CHUNK = 300; // tickets por POST (evita exceder el límite de 2mb del body)
async function push(tickets, emit = true) {
  if (!tickets.length) return { inserted: 0 };
  if (DRY) {
    console.log(`   [dry] ${tickets.length} tickets (emit=${emit}) · muestra:`, JSON.stringify(tickets[0], null, 0).slice(0, 300));
    return { inserted: 0 };
  }
  let inserted = 0;
  for (let i = 0; i < tickets.length; i += CHUNK) {
    const batch = tickets.slice(i, i + CHUNK);
    // TIMEOUT obligatorio: sin él, un 502/hang de Railway deja el fetch colgado para
    // siempre → el await nunca resuelve → el guard `running` queda atascado en true →
    // el poller se congela mudo (proceso vivo pero sin tickear). Visto 2026-08-04.
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-ingest-key': INGEST_KEY },
      body: JSON.stringify({ tickets: batch, emit }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const r = await res.json();
    inserted += r.inserted || 0;
  }
  return { inserted };
}

let running = false;
let first = true; // primer ciclo = backfill del día completo (silencioso, sin WS)
async function tick() {
  if (running) return; // evita solape si un ciclo tarda más que el intervalo
  running = true;
  // finally OBLIGATORIO: garantiza que `running` se libere pase lo que pase (throw o
  // no). Sin esto, un error fuera del try por-rama dejaba el guard atascado en true y
  // el poller se congelaba. Combinado con el timeout de fetch, ya no puede colgarse.
  try {
    const backfill = first;
    const since = backfill ? startOfTodayMX() : sinceLocalMX(WINDOW_MIN);
    let total = 0, ins = 0;
    for (const b of BRANCHES) {
      try {
        const tickets = await pollBranch(b, since);
        // backfill: emit=false (el navegador lo trae vía snapshot, sin inundar el WS).
        if (tickets.length) { const r = await push(tickets, !backfill); total += tickets.length; ins += (r.inserted || 0); }
      } catch (e) { console.log(`⚠️  ${b.db}: ${e.message.split('\n')[0]}`); }
    }
    if (total || backfill) {
      const tag = backfill ? `BACKFILL día≥${since}` : `ventana≥${since}`;
      console.log(`[${new Date().toISOString()}] ${tag} · ${total} tickets vistos · ${ins} nuevos${backfill ? ' (buffer)' : ' → WS'}`);
    }
    first = false;
  } finally {
    running = false;
  }
}

// No dejar que un rechazo/excepción no manejada tumbe o mudee el loop en silencio.
process.on('unhandledRejection', (e) => console.log(`⚠️  unhandledRejection: ${(e && e.message) || e}`));
process.on('uncaughtException', (e) => console.log(`⚠️  uncaughtException: ${(e && e.message) || e}`));

console.log(`Tienda live poller — ${DRY ? 'DRY-RUN (1 ciclo, sin push)' : `cada ${POLL_MS / 1000}s, ventana ${WINDOW_MIN}min → ${INGEST_URL}`}`);
if (DRY) {
  tick().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  tick();
  setInterval(tick, POLL_MS);
}
