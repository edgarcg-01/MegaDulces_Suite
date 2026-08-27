/* eslint-disable no-console */
/**
 * Sink de feeds — decide CÓMO se aplica un changeset, sin que el importer sepa el transporte.
 *
 *   FEEDS_SINK=pg   (default) → aplica directo con el Client del importer (proxy público Railway).
 *   FEEDS_SINK=http           → gzip + POST del changeset a `services/feeds-ingest`
 *                               (ingress GRATIS; el servicio escribe por red interna GRATIS).
 *
 * Uso desde un importer:
 *   const sink = require('../lib/sink');
 *   const rows = [...];                    // objetos JSON serializables
 *   const r = await sink.ship('stock-delta', { rows, tenantId: M, client: db });
 *   // r = { ok, mode, rowCount, received?, ms? }
 *
 * En modo pg, `client` es obligatorio (Client de pg ya conectado). En modo http se ignora.
 * Rollback instantáneo: volver a FEEDS_SINK=pg (o quitar la env) restaura el comportamiento previo.
 *
 * ESPEJO (FEEDS_MIRROR_URL): además del destino primario, aplica el MISMO changeset a una
 * segunda DB (la réplica de pruebas en .245). Una sola lectura del origen local → dos destinos.
 * Best-effort por diseño: si el espejo falla o está caído, el feed primario sigue como si nada
 * (nunca lanza, nunca cambia el resultado). Quitar la env = rollback total.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
// apply-handlers vive junto al servicio feeds-ingest (única fuente del SQL de apply);
// el modo pg lo reutiliza aquí on-prem.
const { HANDLERS } = require('../../../services/feeds-ingest/apply-handlers');

const DEFAULT_TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

function sinkMode() {
  return (process.env.FEEDS_SINK || 'pg').toLowerCase();
}

async function ship(feed, { rows, tenantId = DEFAULT_TENANT, client = null, meta = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let res;
  if (sinkMode() === 'http') {
    res = await shipHttp(feed, { rows: list, tenantId, meta });
  } else {
    // modo pg: aplicar en proceso con el Client del importer
    const handler = HANDLERS[feed];
    if (!handler) throw new Error(`sink(pg): feed desconocido '${feed}'`);
    if (!client) throw new Error(`sink(pg): feed '${feed}' requiere un Client de pg conectado`);
    const rowCount = await handler(client, tenantId, list, meta);
    res = { ok: true, mode: 'pg', rowCount };
  }
  await shipMirror(feed, { rows: list, tenantId, meta }); // nunca lanza
  return res;
}

// ---------------------------------------------------------------------------
// Espejo a una segunda DB (FEEDS_MIRROR_URL). Reusa los mismos HANDLERS que el
// modo pg, así que el SQL de apply sigue teniendo una sola fuente.
// ---------------------------------------------------------------------------
let mirrorClient = null;
let mirrorOff = false; // se apaga sola en la corrida si el destino no responde

function mirrorUrl() {
  const u = process.env.FEEDS_MIRROR_URL || '';
  if (!u) return '';
  // Salvavidas: el espejo es para la réplica local. Apuntarlo a Railway duplicaría
  // el apply sobre prod (o lo escribiría dos veces desde dos rutas distintas).
  if (/proxy\.rlwy\.net|railway/i.test(u)) {
    if (!mirrorOff) console.error('sink(mirror): FEEDS_MIRROR_URL apunta a Railway/prod → espejo IGNORADO');
    mirrorOff = true;
    return '';
  }
  return u;
}

// El Client del espejo queda unref'd: un socket idle NO debe impedir que el proceso
// termine (los importers cierran con `process.exitCode`, no con process.exit()).
// Se hace ref() solo mientras hay una escritura en vuelo.
function mirrorStream() {
  try { return mirrorClient && mirrorClient.connection && mirrorClient.connection.stream; } catch { return null; }
}

async function getMirror() {
  if (mirrorOff) return null;
  const url = mirrorUrl();
  if (!url) return null;
  if (mirrorClient) return mirrorClient;
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: url, application_name: 'feeds-mirror' });
    c.on('error', (e) => { console.error('sink(mirror): conexión perdida: ' + String(e.message).slice(0, 120)); mirrorOff = true; mirrorClient = null; });
    await c.connect();
    mirrorClient = c;
    const s = mirrorStream();
    if (s && s.unref) s.unref();
    return c;
  } catch (e) {
    mirrorOff = true;
    console.error('sink(mirror): sin conexión → espejo DESACTIVADO en esta corrida: ' + String(e.message).slice(0, 140));
    return null;
  }
}

async function shipMirror(feed, { rows, tenantId, meta }) {
  const handler = HANDLERS[feed];
  if (!handler) return; // feed sin handler: el primario ya se quejó
  const c = await getMirror();
  if (!c) return;
  const s = mirrorStream();
  try {
    if (s && s.ref) s.ref();
    await handler(c, tenantId, rows, meta);
  } catch (e) {
    console.error(`sink(mirror): '${feed}' falló (no fatal): ` + String(e.message).slice(0, 160));
  } finally {
    if (s && s.unref) s.unref();
  }
}

function shipHttp(feed, { rows, tenantId, meta }) {
  return new Promise((resolve, reject) => {
    const base = process.env.FEEDS_INGEST_URL;
    if (!base) return reject(new Error('FEEDS_SINK=http pero falta FEEDS_INGEST_URL'));
    const key = process.env.FEEDS_INGEST_KEY;
    if (!key) return reject(new Error('FEEDS_SINK=http pero falta FEEDS_INGEST_KEY'));

    const u = new URL(`/ingest/${encodeURIComponent(feed)}`, base);
    // JSONL: línea 0 = header {tenant_id, meta, count}; líneas 1..N = filas.
    const payload = [JSON.stringify({ tenant_id: tenantId, meta: meta || null, count: rows.length })]
      .concat(rows.map((r) => JSON.stringify(r)))
      .join('\n');
    const body = zlib.gzipSync(Buffer.from(payload, 'utf8'));
    const lib = u.protocol === 'https:' ? https : http;

    // DEADLINE DURO de toda la operación. El `timeout` de abajo es de INACTIVIDAD de socket:
    // no cubre un servidor que gotea bytes, ni una respuesta que se corta sin emitir 'error'
    // en el request. Sin este reloj el ship puede no resolver NUNCA y el loop del .cmd se
    // queda esperando para siempre — fue el cuelgue de 2 días del CDC del ODS (24-ago).
    const HARD_MS = Number(process.env.FEEDS_INGEST_TIMEOUT_MS) || 120000;
    let req = null;
    let settled = false;
    let deadline = null;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) { try { if (req) req.destroy(); } catch { /* ya cerrado */ } reject(err); } else resolve(val);
    };

    req = lib.request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-ndjson',
          'content-encoding': 'gzip',
          'content-length': body.length,
          'x-ingest-key': key,
        },
        timeout: 60000,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        // Sin este handler, una respuesta cortada emite 'error' en el stream y nadie lo escucha
        // → la promesa queda colgada (y en Node un 'error' sin listener puede tumbar el proceso).
        res.on('error', (e) => done(new Error(`ingest '${feed}': respuesta cortada: ${e.message}`)));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed = {};
            try { parsed = JSON.parse(data || '{}'); } catch { parsed = { raw: data }; }
            done(null, { ok: true, mode: 'http', ...parsed });
          } else {
            done(new Error(`ingest '${feed}' → HTTP ${res.statusCode}: ${String(data).slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', (e) => done(e));
    req.on('timeout', () => done(new Error(`ingest '${feed}': socket inactivo 60s`)));
    deadline = setTimeout(() => done(new Error(`ingest '${feed}': deadline de ${HARD_MS}ms superado`)), HARD_MS);
    req.write(body);
    req.end();
  });
}

module.exports = { ship, sinkMode, mirrorUrl };
