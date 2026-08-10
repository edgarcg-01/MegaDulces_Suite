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
  if (sinkMode() === 'http') return shipHttp(feed, { rows: list, tenantId, meta });
  // modo pg: aplicar en proceso con el Client del importer
  const handler = HANDLERS[feed];
  if (!handler) throw new Error(`sink(pg): feed desconocido '${feed}'`);
  if (!client) throw new Error(`sink(pg): feed '${feed}' requiere un Client de pg conectado`);
  const rowCount = await handler(client, tenantId, list, meta);
  return { ok: true, mode: 'pg', rowCount };
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

    const req = lib.request(
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
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed = {};
            try { parsed = JSON.parse(data || '{}'); } catch { parsed = { raw: data }; }
            resolve({ ok: true, mode: 'http', ...parsed });
          } else {
            reject(new Error(`ingest '${feed}' → HTTP ${res.statusCode}: ${String(data).slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`ingest '${feed}': timeout`)));
    req.write(body);
    req.end();
  });
}

module.exports = { ship, sinkMode };
