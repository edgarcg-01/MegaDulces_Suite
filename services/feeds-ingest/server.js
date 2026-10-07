/* eslint-disable no-console */
/**
 * feeds-ingest — servicio de INGESTA que vive DENTRO de Railway.
 *
 * Por qué existe: el runner on-prem no puede escribir a Postgres barato (el proxy público
 * factura las respuestas como egress). Este servicio recibe el changeset por HTTPS
 * (ingress = GRATIS) y lo escribe por red interna `*.railway.internal` (interno = GRATIS),
 * usando exactamente el mismo SQL de apply que el importer (database/importers/lib/apply-handlers).
 *
 * Aislado del API a propósito (el API sufre OOM → ECONNRESET; ver hang-pattern).
 *
 * Protocolo:
 *   POST /ingest/:feed        header X-Ingest-Key: <FEEDS_INGEST_KEY>
 *     body = gzip(JSONL): línea 0 = {tenant_id, meta, count}; líneas 1..N = filas
 *     → 200 { ok, feed, received, rowCount, ms }
 *   GET  /health              → 200 { ok }
 *
 * Env: DATABASE_URL_NEW (interno), FEEDS_INGEST_KEY, PORT (default 8080), MAX_BODY_MB (default 32).
 */

const http = require('http');
const zlib = require('zlib');
const { Client } = require('pg');
const { HANDLERS, UUID_RE } = require('./apply-handlers');

const PORT = Number(process.env.PORT) || 8080;
const KEY = process.env.FEEDS_INGEST_KEY;
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 32) * 1024 * 1024;

function defaultDbClient() {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('sin DATABASE_URL_NEW/DATABASE_URL');
  // Interno (railway.internal / LAN / localhost) no necesita SSL; público → sin verificar cert.
  const ssl = /@(localhost|127\.0\.0\.1|192\.168\.|[^@/]*\.railway\.internal)/.test(cs)
    ? false
    : { rejectUnauthorized: false };
  return new Client({ connectionString: cs, ssl, connectionTimeoutMillis: 10000, statement_timeout: 60000, keepAlive: true });
}

// Inyectable para pruebas (evita tocar una DB real en el smoke).
let dbClientFactory = defaultDbClient;
function setDbClientFactory(fn) { dbClientFactory = fn; }

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });

  const m = req.url && req.url.match(/^\/ingest\/([a-z0-9._-]+)$/i);
  if (req.method !== 'POST' || !m) return send(404, { error: 'not found' });
  if (!KEY || req.headers['x-ingest-key'] !== KEY) return send(401, { error: 'unauthorized' });

  const feed = m[1];
  const handler = HANDLERS[feed];
  if (!handler) return send(400, { error: `feed desconocido: ${feed}` });

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      send(413, { error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (aborted) return;
    let text;
    try {
      const raw = Buffer.concat(chunks);
      text = (req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw).toString('utf8');
    } catch (e) {
      return send(400, { error: `gunzip failed: ${e.message}` });
    }
    const lines = text.split('\n').filter((l) => l.length);
    if (!lines.length) return send(400, { error: 'empty body' });
    let head, rows;
    try {
      head = JSON.parse(lines[0]);
      rows = lines.slice(1).map((l) => JSON.parse(l));
    } catch (e) {
      return send(400, { error: `bad jsonl: ${e.message}` });
    }
    const tenantId = head && head.tenant_id;
    if (!UUID_RE.test(String(tenantId || ''))) return send(400, { error: 'tenant_id inválido' });

    const client = dbClientFactory();
    const t0 = Date.now();
    // `[OBS.7]` Qué se estaba escribiendo. Sin esto el error de abajo decía sólo el FEED
    // (`raw-upsert`), que es el mismo para las ~30 tablas que pasan por acá: un
    // `canceling statement due to statement timeout` era literalmente indiagnosticable.
    // Medido el 2026-09-11 en los logs de prod: 17 timeouts de `stock-delta` + 14 de
    // `raw-upsert` + 4 `timeout expired` (ése es el POOL, no el statement) en 400 líneas,
    // y ninguno decía sobre qué tabla.
    const meta = (head && head.meta) || null;
    const donde = meta && meta.table
      ? `${meta.schema || 'kepler_ods'}.${meta.table}`
      : '(sin meta)';
    /** Umbral para avisar ANTES de que cruce: el statement_timeout del cliente es 60 s. */
    const LENTO_MS = 10000;
    try {
      await client.connect();
      const rowCount = await handler(client, tenantId, rows, meta);
      const ms = Date.now() - t0;
      // Un lote que ya tarda 10 s es el mismo que mañana tarda 60 y se cancela. Se avisa
      // mientras todavía es un aviso y no un incidente.
      if (ms >= LENTO_MS) {
        console.warn(`[ingest] ${feed} LENTO: ${donde} · ${rows.length} filas · ${rowCount} escritas · ${ms} ms`);
      }
      send(200, { ok: true, feed, received: rows.length, rowCount, ms });
    } catch (e) {
      console.error(
        `[ingest] ${feed} error: ${donde} · ${rows.length} filas · ${Date.now() - t0} ms · ${e.message}`,
      );
      send(500, { error: e.message });
    } finally {
      try { await client.end(); } catch { /* noop */ }
    }
  });
  req.on('error', () => { if (!aborted) send(400, { error: 'request error' }); });
});

module.exports = { server, setDbClientFactory, HANDLERS };

if (require.main === module) {
  if (!KEY) console.warn('[feeds-ingest] ADVERTENCIA: FEEDS_INGEST_KEY no seteado — todos los POST serán 401.');
  server.listen(PORT, () => console.log(`[feeds-ingest] escuchando en :${PORT}`));
}
