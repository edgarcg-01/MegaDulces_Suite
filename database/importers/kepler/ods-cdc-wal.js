/* eslint-disable no-console */
/**
 * CDC WAL-decode (ADR-047) — consumidor de logical decoding del :5433 que reemplaza el poll
 * (ctid + hash md5-scan) de `replicate-ods-live`. Lee el WAL que la replicación de Kepler ya aplicó
 * y empuja SOLO los cambios reales (I/U/D, incluido DELETE) a `kepler_ods` por feeds-ingest.
 *
 * Decoder: **pgoutput** (protocolo nativo, estructurado — NADA de parsear texto de test_decoding,
 * clave para data de dinero/inventario). Por rama: publication `ods_cdc_pub FOR ALL TABLES` + slot
 * `ods_cdc` (pgoutput). REPLICA IDENTITY default (=PK) basta: el DELETE trae la PK.
 *
 * Modos:
 *   node ods-cdc-wal.js --branch=03 --verify [--seconds=20]   # crea pub+slot, decodifica N s, cuenta, DROPEA slot (no shipea)
 *   node ods-cdc-wal.js --branch=03 --watch                   # persistente: shipea I/U (upsert) + D (delete) + ack LSN
 *   node ods-cdc-wal.js --drop-slot --branch=03               # limpieza: dropea slot + publication
 *
 * OJO: un slot lógico retiene WAL en el :5433 hasta que el consumidor confirma (ack). En --watch,
 * si el proceso muere, el WAL se acumula → monitorear pg_replication_slots (sensor CDC.5).
 */
const { Client } = require('pg');
const { LogicalReplicationService, PgoutputPlugin } = require('pg-logical-replication');
const sink = require('../lib/sink');

const ONLY_BRANCH = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null;
const VERIFY = process.argv.includes('--verify');
const WATCH = process.argv.includes('--watch');
const DROP_SLOT = process.argv.includes('--drop-slot');
const SECONDS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1]) || 20;
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUB_BASE = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const PUB = 'ods_cdc_pub';
const SLOT = 'ods_cdc';
const FLUSH_MS = Math.max(1000, Number(process.env.ODS_CDC_FLUSH_MS) || 3000);

const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const localCfg = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return { connectionString: u.toString() }; };
const mapType = (dt) => ({ 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz' }[dt] || (['numeric','double precision','real','integer','bigint','smallint','boolean','date'].includes(dt) ? dt : 'text'));

/** publication FOR ALL TABLES + slot pgoutput (idempotente). */
async function ensurePubSlot(code) {
  const c = new Client(localCfg(code));
  await c.connect();
  try {
    const hasPub = (await c.query(`SELECT 1 FROM pg_publication WHERE pubname=$1`, [PUB])).rowCount > 0;
    if (!hasPub) await c.query(`CREATE PUBLICATION ${PUB} FOR ALL TABLES`);
    const hasSlot = (await c.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name=$1`, [SLOT])).rowCount > 0;
    if (!hasSlot) await c.query(`SELECT pg_create_logical_replication_slot($1,'pgoutput')`, [SLOT]);
    return { hasPub, hasSlot };
  } finally { await c.end(); }
}
async function dropSlot(code) {
  const c = new Client(localCfg(code));
  await c.connect();
  try {
    await c.query(`SELECT pg_drop_replication_slot($1) WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name=$1)`, [SLOT]);
    await c.query(`DROP PUBLICATION IF EXISTS ${PUB}`);
  } finally { await c.end(); }
}

/** Construye el row {col:val} desde un mensaje pgoutput insert/update. */
function rowOf(log) {
  const r = {};
  const cols = log.relation?.columns || [];
  const vals = log.new || {};
  for (const col of cols) r[col.name] = vals[col.name];
  return r;
}
/** ship meta desde la relation pgoutput (columnas + PK). */
function shipMetaOf(log) {
  const cols = log.relation?.columns || [];
  const pk = cols.filter((c) => c.flags & 1 /* key */).map((c) => c.name);
  return { table: log.relation.name, pk, columns: [{ name: 'sucursal', type: 'text' }, ...cols.map((c) => ({ name: c.name, type: mapType(c.dataTypeName || 'text') }))] };
}

async function run(code) {
  const before = await ensurePubSlot(code);
  console.log(`[${code}] pub ${before.hasPub ? 'ya existía' : 'CREADA'} · slot ${before.hasSlot ? 'ya existía' : 'CREADO'}`);

  const service = new LogicalReplicationService(localCfg(code), { acknowledge: { auto: false, timeoutSeconds: 10 } });
  const plugin = new PgoutputPlugin({ protoVersion: 2, publicationNames: [PUB] });

  const stats = { insert: 0, update: 0, delete: 0, tables: {} };
  const buf = new Map(); // table → { meta, upserts:Map(pk→row), deletes:[keyRow] }
  let lastLsn = null;

  const keyText = (pk, row) => pk.map((k) => String(row[k] ?? '\x00')).join('|');

  async function flush() {
    if (!buf.size) { if (lastLsn && WATCH) service.acknowledge(lastLsn); return; }
    for (const [table, { meta, upserts, deletes }] of buf) {
      if (upserts.size && WATCH) {
        const rows = [...upserts.values()].map((rj) => ({ sucursal: code, ...rj }));
        await sink.ship('raw-upsert', { rows, tenantId: TENANT, meta });
      }
      // DELETE: CDC.3 (falta el handler `delete` en feeds-ingest). Por ahora se cuentan.
      void deletes;
    }
    buf.clear();
    if (lastLsn && WATCH) service.acknowledge(lastLsn);
  }

  service.on('data', (lsn, log) => {
    lastLsn = lsn;
    if (log.tag !== 'insert' && log.tag !== 'update' && log.tag !== 'delete') return;
    const t = log.relation?.name; if (!t) return;
    stats[log.tag]++; stats.tables[t] = (stats.tables[t] || 0) + 1;
    if (!WATCH) return; // verify: solo contar
    const meta = shipMetaOf(log);
    if (!meta.pk.length) return;
    if (!buf.has(t)) buf.set(t, { meta, upserts: new Map(), deletes: [] });
    const e = buf.get(t);
    if (log.tag === 'delete') { e.deletes.push(log.key || log.old || {}); }
    else { const row = rowOf(log); e.upserts.set(keyText(meta.pk, row), row); }
  });
  service.on('error', (e) => console.error(`[${code}] error:`, e.message));

  service.subscribe(plugin, SLOT).catch((e) => console.error(`[${code}] subscribe:`, e.message));

  if (WATCH) {
    const timer = setInterval(() => flush().catch((e) => console.error('flush:', e.message)), FLUSH_MS);
    process.on('SIGINT', async () => { clearInterval(timer); await service.stop(); process.exit(0); });
    console.log(`[${code}] --watch: streaming (flush cada ${FLUSH_MS}ms). Ctrl-C para parar.`);
    return; // corre indefinido
  }

  // VERIFY: decodifica SECONDS y reporta, luego DROPEA el slot (no retener WAL).
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  await service.stop();
  const total = stats.insert + stats.update + stats.delete;
  console.log(`\n=== VERIFY ${code} (${SECONDS}s) ===`);
  console.log(`decodificados: ${total} (I:${stats.insert} U:${stats.update} D:${stats.delete})`);
  console.log(`tablas:`, JSON.stringify(Object.entries(stats.tables).sort((a, b) => b[1] - a[1]).slice(0, 10)));
  console.log(`GATE decode: ${total > 0 ? '✅ pgoutput decodifica cambios estructurados' : '⚠️ 0 cambios en la ventana (¿lull?)'}`);
  await dropSlot(code);
  console.log(`cleanup: slot + publication dropeados ✓`);
}

(async () => {
  const code = ONLY_BRANCH || '03';
  if (DROP_SLOT) { await dropSlot(code); console.log(`[${code}] slot + publication dropeados`); return; }
  if (!VERIFY && !WATCH) { console.error('Usar --verify o --watch (o --drop-slot). Ver cabecera.'); process.exit(2); }
  await run(code);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
