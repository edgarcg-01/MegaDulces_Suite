/* eslint-disable no-console */
/**
 * Smoke de PROTOCOLO para feeds-ingest — NO toca una DB real.
 * Verifica el round-trip sink(http) → server → handler + auth + routing + gzip/JSONL,
 * inyectando un Client de pg falso y un handler de prueba.
 *
 *   node database/importers/kepler/_smoke-feeds-ingest.js
 */

const assert = require('assert');
const PORT = 8791;

// Config de entorno ANTES de requerir sink/server.
process.env.FEEDS_INGEST_KEY = 'smoke-key';
process.env.FEEDS_SINK = 'http';
process.env.FEEDS_INGEST_URL = `http://127.0.0.1:${PORT}`;

const ingest = require('../../../services/feeds-ingest/server');
const sink = require('../lib/sink');

const M = '00000000-0000-0000-0000-00000000d01c';
let captured = null;

// Handler de prueba: registra lo recibido y devuelve rowCount = rows.length.
ingest.HANDLERS['smoke-echo'] = async (client, tenantId, rows, meta) => {
  captured = { tenantId, rows, meta };
  assert.ok(client && typeof client.query === 'function', 'handler recibe un client');
  return rows.length;
};
// Client de pg falso (sin DB).
ingest.setDbClientFactory(() => ({
  connect: async () => {},
  query: async () => ({ rowCount: 0, rows: [] }),
  end: async () => {},
}));

function httpJson(method, path, headers) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

(async () => {
  await new Promise((r) => ingest.server.listen(PORT, r));
  let pass = 0;
  try {
    // 1. health
    const h = await httpJson('GET', '/health', {});
    assert.strictEqual(h.status, 200, 'health 200'); pass++;

    // 2. happy path via sink (gzip + JSONL + auth header correcto)
    const rows = [
      { code: '01', product_id: M, quantity: 5 },
      { code: '02', product_id: M, quantity: 0 },
      { code: '03', product_id: M, quantity: 12 },
    ];
    const r = await sink.ship('smoke-echo', { rows, tenantId: M, meta: { note: 'smoke' } });
    assert.strictEqual(r.mode, 'http', 'modo http'); pass++;
    assert.strictEqual(r.received, 3, 'recibió 3 filas'); pass++;
    assert.strictEqual(r.rowCount, 3, 'rowCount = 3'); pass++;
    assert.strictEqual(captured.tenantId, M, 'tenant llegó intacto'); pass++;
    assert.deepStrictEqual(captured.rows, rows, 'filas llegaron intactas (gzip+jsonl round-trip)'); pass++;
    assert.strictEqual(captured.meta.note, 'smoke', 'meta llegó'); pass++;

    // 3. auth: key equivocada → 401 (sink lanza)
    process.env.FEEDS_INGEST_KEY = 'wrong-key-for-client';
    let threw = false;
    try { await sink.ship('smoke-echo', { rows, tenantId: M }); } catch (e) { threw = /401/.test(e.message); }
    process.env.FEEDS_INGEST_KEY = 'smoke-key';
    assert.ok(threw, 'key equivocada → 401'); pass++;

    // 4. feed desconocido → 400
    threw = false;
    try { await sink.ship('feed-que-no-existe', { rows, tenantId: M }); } catch (e) { threw = /400/.test(e.message); }
    assert.ok(threw, 'feed desconocido → 400'); pass++;

    // 5. tenant inválido → 400
    threw = false;
    try { await sink.ship('smoke-echo', { rows, tenantId: 'no-uuid' }); } catch (e) { threw = /400/.test(e.message); }
    assert.ok(threw, 'tenant inválido → 400'); pass++;

    console.log(`\n✅ feeds-ingest protocol smoke: ${pass}/10 OK`);
  } catch (e) {
    console.error(`\n❌ smoke falló tras ${pass} asserts: ${e.message}`);
    process.exitCode = 1;
  } finally {
    ingest.server.close();
  }
})();
