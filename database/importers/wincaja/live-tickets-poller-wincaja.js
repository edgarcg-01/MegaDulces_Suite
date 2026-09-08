/* eslint-disable no-console */
/**
 * Proyecto Tienda — POLLER de tickets en vivo de **Wincaja** (`[TDA.Wincaja]`).
 *
 * Hermano de `database/importers/kepler/live-tickets-poller.js`. Ése lee los POS Kepler (`md.kdm1/
 * kdm2`) y empuja tickets al monitor `/tienda/live`. Este hace lo mismo para las tiendas que corren
 * **Wincaja** —Morelia Abastos (`30`) y Morelia Madero (`32`)— que hasta hoy NO aparecían en el
 * monitor porque su venta no está en Kepler.
 *
 * ── De dónde lee ────────────────────────────────────────────────────────────────────────────
 * De la **réplica cruda** `:5433/wincaja` (schemas `w30`/`w32`), NO del bronze de prod: la réplica
 * la refresca `wincaja-inc` cada ~2 min, así que es la única copia "viva" de Wincaja. El bronze
 * `wincaja.*` de prod corre 1×/día — serviría inventario de ayer.
 *
 * ⚠️ **Latencia honesta:** el eslabón más lento manda. Kepler tickea a ~25 s; Wincaja depende del
 * carril `wincaja-inc` (~2 min) MÁS este poll, así que sus tickets aparecen con ~2–3 min de retraso.
 * Es "en vivo" suficiente para un monitor de tienda, pero no es comparable al de Kepler y no hay que
 * dibujarlo como si lo fuera.
 *
 * ── El decode (verificado 2026-09-08, NO adivinado) ────────────────────────────────────────────
 * Venta POS = cabecera `MaestroMovAlmacen "Tipo"='V'` ⋈ detalle `DetallesMovAlmacen "Tipo"='V'` por
 * `Consecutivo`. Es el MISMO criterio que `wincaja.v_sales_lines` (que decodifica el bronze), traído
 * al crudo: `d."Tipo"='V'`, `ValorVenta` = importe, `CantidadRegular` = cantidad, `Articulo` = sku,
 * nombre desde `Articulos.Nombre`. En el crudo todo es `text`/`numeric` (tipos laxos del espejo);
 * `Fecha` es ISO `"YYYY-MM-DDT00:00:00"` (medianoche UTC = fecha de negocio) y `Hora` es
 * `"1899-12-30THH:MM:SS"`, así que el ts se compone con `substr`.
 *
 * Emite el MISMO shape de ticket y al MISMO endpoint que el de Kepler (`POST /store/live/ingest`,
 * upsert idempotente por `(warehouse_code, serie, folio)` → sólo los nuevos salen por WS). El
 * backend no valida contra whitelist, así que `30`/`32` entran sin tocar el API.
 *
 * Env (mismos que el de Kepler, para reusar el ecosystem):
 *   STORE_INGEST_URL   = https://<api-prod>/api/store/live/ingest
 *   STORE_INGEST_KEY   = <clave compartida>
 *   WINCAJA_REPLICA_URL= postgresql://…@localhost:5433/wincaja   (default del proyecto)
 *   POLL_SECONDS = 60 (opcional) · WINDOW_MINUTES = 20 (opcional — más ancha que Kepler por la
 *                  latencia del carril inc; el upsert idempotente absorbe el solape)
 *
 *   node database/importers/wincaja/live-tickets-poller-wincaja.js --dry   # 1 ciclo, no empuja
 */
'use strict';
const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const INGEST_URL = process.env.STORE_INGEST_URL || 'http://localhost:3000/api/store/live/ingest';
const INGEST_KEY = process.env.STORE_INGEST_KEY || 'dev_store_ingest_key';
const REPLICA_URL = process.env.WINCAJA_REPLICA_URL || 'postgresql://postgres:superoot@localhost:5433/wincaja';
const POLL_MS = (Number(process.env.POLL_SECONDS) || 60) * 1000;
const WINDOW_MIN = Number(process.env.WINDOW_MINUTES) || 20;
const DRY = process.argv.includes('--dry');

/**
 * Sucursales Wincaja que venden al público y tienen espejo vivo. NO el CEDIS `00` (bodegón, no
 * vende). `code` es el de 2 dígitos que el monitor agrupa (igual criterio que STORE_BRANCHES).
 * Se deriva de la réplica: cualquier schema `w##` que no sea el `00`. Hardcode explícito porque son
 * las dos que hoy existen; si aparece otra tienda Wincaja, se agrega acá.
 */
const BRANCHES = [
  { schema: 'w30', code: '30', name: 'Morelia Abastos' },
  { schema: 'w32', code: '32', name: 'Morelia Madero' },
];

const pad = (n) => String(n).padStart(2, '0');
/** "YYYY-MM-DD" del día de HOY en hora local MX (offset fijo −06, Centro sin DST). */
function todayMX() {
  const nowMx = new Date(Date.now() - 6 * 3600 * 1000);
  return `${nowMx.getUTCFullYear()}-${pad(nowMx.getUTCMonth() + 1)}-${pad(nowMx.getUTCDate())}`;
}
/** "HH:MM:SS" de hace `minutesAgo` minutos, en hora local MX — para acotar la ventana intradía. */
function timeAgoMX(minutesAgo) {
  const mx = new Date(Date.now() - 6 * 3600 * 1000 - minutesAgo * 60 * 1000);
  return `${pad(mx.getUTCHours())}:${pad(mx.getUTCMinutes())}:${pad(mx.getUTCSeconds())}`;
}

async function pollBranch(b, day, sinceTime) {
  const c = new Client({ connectionString: REPLICA_URL, connectionTimeoutMillis: 6000, statement_timeout: 30000 });
  await c.connect();
  try {
    // Ventana: ventas de HOY (business_date = day) cuya HORA sea >= sinceTime. El día está en
    // `substr(Fecha,1,10)`; la hora en `substr(Hora,12,8)`. El backfill del primer ciclo pasa
    // sinceTime='00:00:00' (todo el día); los ciclos siguientes, la ventana deslizante.
    const q = `
      SELECT m."Consecutivo"::text AS consec, btrim(m."Documento") AS documento,
             btrim(m."Caja") AS caja, btrim(m."Cajero") AS cajero, btrim(m."Vendedor") AS vendedor,
             btrim(m."Tercero") AS tercero,
             substr(m."Fecha", 1, 10) AS fecha, substr(m."Hora", 12, 8) AS hora,
             btrim(d."Articulo") AS sku, coalesce(a."Nombre", a."Descripcion") AS nombre,
             d."CantidadRegular"::numeric AS cant, d."ValorVenta"::numeric AS importe
        FROM ${b.schema}."MaestroMovAlmacen" m
        JOIN ${b.schema}."DetallesMovAlmacen" d ON d."Consecutivo" = m."Consecutivo"
        LEFT JOIN ${b.schema}."Articulos" a ON btrim(a."Articulo") = btrim(d."Articulo")
       WHERE m."Tipo" = 'V' AND d."Tipo" = 'V'
         AND coalesce(btrim(m."Cancelado"), '') NOT IN ('1', '-1', 'true', 'True', 'Si', 'Sí')
         AND substr(m."Fecha", 1, 10) = $1
         AND substr(m."Hora", 12, 8) >= $2
         AND btrim(d."Articulo") <> ''
         AND d."ValorVenta"::numeric >= 0 AND d."ValorVenta"::numeric < 10000000
       ORDER BY m."Consecutivo"`;
    const { rows } = await c.query(q, [day, sinceTime]);

    const byTicket = new Map();
    for (const r of rows) {
      // serie|folio = identidad del ticket. El Documento ('T320285943', 'F300018212') es único por
      // sucursal; se usa entero como folio y la sucursal como serie, para que el upsert
      // `(warehouse_code, serie, folio)` no colisione entre ramas ni entre días (el Documento no se
      // reinicia dentro de la operación de una tienda).
      const folio = r.documento || r.consec;
      const serie = b.code;
      const key = `${serie}|${folio}`;
      let t = byTicket.get(key);
      if (!t) {
        const hora = (r.hora || '00:00:00').slice(0, 5); // HH:MM
        t = {
          warehouse_code: b.code, warehouse_name: b.name, serie, folio,
          ticket_ts: `${r.fecha}T${hora}:00-06:00`,
          total: 0, forma_pago: null, cajero: r.cajero || null,
          caja: r.caja || null, items: [],
        };
        byTicket.set(key, t);
      }
      const importe = Number(r.importe) || 0;
      t.total += importe;
      t.items.push({ sku: r.sku, nombre: r.nombre || r.sku, cant: Number(r.cant) || 0, importe });
    }
    return [...byTicket.values()];
  } finally { await c.end().catch(() => {}); }
}

const CHUNK = 300;
async function push(tickets, emit = true) {
  if (!tickets.length) return { inserted: 0 };
  if (DRY) {
    console.log(`   [dry] ${tickets.length} tickets (emit=${emit}) · muestra:`,
      JSON.stringify(tickets[0], null, 0).slice(0, 320));
    return { inserted: 0 };
  }
  let inserted = 0;
  for (let i = 0; i < tickets.length; i += CHUNK) {
    const batch = tickets.slice(i, i + CHUNK);
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-ingest-key': INGEST_KEY },
      body: JSON.stringify({ tickets: batch, emit }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 120)}`);
    inserted += (await res.json()).inserted || 0;
  }
  return { inserted };
}

let running = false;
let first = true;
async function tick() {
  if (running) return;
  running = true;
  try {
    const backfill = first;
    const day = todayMX();
    const sinceTime = backfill ? '00:00:00' : timeAgoMX(WINDOW_MIN);
    let total = 0; let ins = 0;
    for (const b of BRANCHES) {
      try {
        const tickets = await pollBranch(b, day, sinceTime);
        if (tickets.length) { const r = await push(tickets, !backfill); total += tickets.length; ins += (r.inserted || 0); }
      } catch (e) { console.log(`⚠️  ${b.schema}: ${e.message.split('\n')[0]}`); }
    }
    if (total || backfill) {
      const tag = backfill ? `BACKFILL día ${day}` : `ventana ${day} ≥${sinceTime}`;
      console.log(`[${new Date().toISOString()}] ${tag} · ${total} tickets · ${ins} nuevos${backfill ? ' (buffer)' : ' → WS'}`);
    }
    first = false;
  } finally { running = false; }
}

process.on('unhandledRejection', (e) => console.log(`⚠️  unhandledRejection: ${(e && e.message) || e}`));
process.on('uncaughtException', (e) => console.log(`⚠️  uncaughtException: ${(e && e.message) || e}`));

console.log(`Tienda live poller WINCAJA — ${DRY ? 'DRY-RUN (1 ciclo, sin push)' : `cada ${POLL_MS / 1000}s, ventana ${WINDOW_MIN}min → ${INGEST_URL}`}`);
if (DRY) {
  tick().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  tick();
  setInterval(tick, POLL_MS);
}
