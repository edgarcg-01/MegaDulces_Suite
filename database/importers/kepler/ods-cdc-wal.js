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
// ODS_SOURCE_BASE = contenedor de replicas lógicas (:5433). Desacoplada de DATABASE_URL_NEW a
// propósito: esa var la mueve dev para apuntar la app a otra base, y si de ahí se derivan los
// `kepler_md_XX` el consumidor WAL se queda buscando los replicas en el server equivocado
// (y calla). Fallback a DATABASE_URL_NEW por compatibilidad. Ver replicate-ods-live.js.
const SUB_BASE = process.env.ODS_SOURCE_BASE || process.env.DATABASE_URL_NEW
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const PUB = 'ods_cdc_pub';
// OJO: los nombres de replication slot son ÚNICOS POR CLUSTER (no por DB). Las 7 ramas viven en el
// MISMO postmaster :5433 → hay que usar un slot por rama (ods_cdc_<code>); si todas usaran 'ods_cdc'
// solo 1 puede existir cluster-wide y las otras 6 chocan ("slot ods_cdc is active for PID ..."). Las
// publications SÍ son por-DB → PUB puede repetir nombre. (Con 1 sola rama el bug no se ve.)
const slotName = (code) => `ods_cdc_${code}`;
const FLUSH_MS = Math.max(1000, Number(process.env.ODS_CDC_FLUSH_MS) || 3000);
const HEARTBEAT_MS = Math.max(10000, Number(process.env.ODS_CDC_HEARTBEAT_MS) || 30000);
const WARN_LAG_MB = Number(process.env.ODS_CDC_WARN_LAG_MB) || 500; // lag del slot > esto → status error (visible)

const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const localCfg = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return { connectionString: u.toString() }; };
const mapType = (dt) => ({ 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz' }[dt] || (['numeric','double precision','real','integer','bigint','smallint','boolean','date'].includes(dt) ? dt : 'text'));
// pgoutput NO resuelve nombres de tipos builtin (typeName=null) → trae typeOid. Mapear el OID al
// nombre pg (alineado al whitelist de odsType en apply-handlers) es CLAVE: si mandáramos todo 'text',
// el INSERT..SELECT contra el destino ya tipado (numeric/date) truena ("column X is of type numeric
// but expression is of type text"). El valor ya viene parseado por el typeParser del OID → casa.
const OID_TYPE = {
  16: 'boolean', 20: 'bigint', 21: 'smallint', 23: 'integer',
  700: 'real', 701: 'double precision', 1700: 'numeric',
  1082: 'date', 1114: 'timestamp', 1184: 'timestamptz',
};
const pgTypeOf = (c) => (c && c.typeName ? mapType(c.typeName) : (OID_TYPE[c && c.typeOid] || 'text'));

/** publication FOR ALL TABLES + slot pgoutput (idempotente). */
async function ensurePubSlot(code) {
  const c = new Client(localCfg(code));
  await c.connect();
  try {
    const hasPub = (await c.query(`SELECT 1 FROM pg_publication WHERE pubname=$1`, [PUB])).rowCount > 0;
    if (!hasPub) await c.query(`CREATE PUBLICATION ${PUB} FOR ALL TABLES`);
    const hasSlot = (await c.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name=$1`, [slotName(code)])).rowCount > 0;
    if (!hasSlot) await c.query(`SELECT pg_create_logical_replication_slot($1,'pgoutput')`, [slotName(code)]);
    return { hasPub, hasSlot };
  } finally { await c.end(); }
}
async function dropSlot(code) {
  const c = new Client(localCfg(code));
  await c.connect();
  try {
    await c.query(`SELECT pg_drop_replication_slot($1) WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name=$1)`, [slotName(code)]);
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
  return { table: log.relation.name, pk, columns: [{ name: 'sucursal', type: 'text' }, ...cols.map((c) => ({ name: c.name, type: pgTypeOf(c) }))] };
}

async function run(code) {
  const before = await ensurePubSlot(code);
  console.log(`[${code}] pub ${before.hasPub ? 'ya existía' : 'CREADA'} · slot ${before.hasSlot ? 'ya existía' : 'CREADO'}`);

  const service = new LogicalReplicationService(localCfg(code), { acknowledge: { auto: false, timeoutSeconds: 10 } });
  const plugin = new PgoutputPlugin({ protoVersion: 2, publicationNames: [PUB] });

  const stats = { insert: 0, update: 0, delete: 0, shipU: 0, shipD: 0, tables: {} };
  // buf: table → { meta, rows:Map(pkText → {op:'U'|'D', row}) } — última operación por PK gana
  // (si una llave se borra y re-inserta en la misma ventana, el orden de commit deja la correcta).
  let buf = new Map();
  let lastLsn = null;

  const keyText = (pk, row) => pk.map((k) => String(row[k] ?? '\x00')).join('|');

  // CDC.7 — SWAP, no clear. El bug que costó ~4,200 filas (2026-08-26 → 31, ~2-7% DIARIO en las 7
  // ramas, incl. renglones de venta de kdm2): `flush()` iteraba `buf`, hacía `await` de los ships
  // (cientos de ms contra Railway) y AL VOLVER llamaba `buf.clear()`. Todo lo que el stream metió al
  // buffer durante ese await se borraba sin haberse shipeado — y peor, el `acknowledge(lastLsn)` de
  // más abajo ackeaba hasta la ÚLTIMA fila vista, incluidas las recién borradas → Postgres tiraba ese
  // WAL y la pérdida quedaba permanente. Además `setInterval` no espera a la pasada anterior, así que
  // dos flush concurrentes se pisaban el mismo Map.
  //
  // Ahora: se TOMA el lote y se deja un buffer nuevo en su lugar; lo que llegue durante el ship cae en
  // el nuevo y sobrevive. Y se ackea el LSN capturado EN EL SWAP, nunca uno posterior al lote enviado.
  let flushing = false;
  async function flush() {
    if (flushing) return;                       // el timer no espera al ship anterior
    flushing = true;
    const lote = buf; const lsn = lastLsn;      // ← swap atómico (JS es single-thread: nada corre en medio)
    buf = new Map();
    try {
      if (!lote.size) { if (lsn) service.acknowledge(lsn); return; }
      for (const [, { meta, rows }] of lote) {
        const ups = [], dels = [];
        for (const { op, row } of rows.values()) (op === 'D' ? dels : ups).push({ sucursal: code, ...row });
        if (ups.length) { await sink.ship('raw-upsert', { rows: ups, tenantId: TENANT, meta }); stats.shipU += ups.length; }
        if (dels.length) { await sink.ship('raw-delete', { rows: dels, tenantId: TENANT, meta }); stats.shipD += dels.length; }
      }
      if (lsn) service.acknowledge(lsn);        // ack SOLO hasta lo que efectivamente se shipeó
    } catch (e) {
      // Ship fallido → el lote vuelve a la cola SIN pisar lo que llegó mientras tanto (eso es más
      // nuevo y manda). Re-shipear de más es inofensivo: el destino es UPSERT idempotente.
      for (const [t, entry] of lote) {
        if (!buf.has(t)) { buf.set(t, entry); continue; }
        const dest = buf.get(t).rows;
        for (const [k, v] of entry.rows) if (!dest.has(k)) dest.set(k, v);
      }
      throw e;
    } finally { flushing = false; }
  }

  service.on('data', (lsn, log) => {
    lastLsn = lsn;
    if (log.tag !== 'insert' && log.tag !== 'update' && log.tag !== 'delete') return;
    const t = log.relation?.name; if (!t) return;
    stats[log.tag]++; stats.tables[t] = (stats.tables[t] || 0) + 1;
    if (!WATCH) return; // verify: solo contar (no bufferea ni shipea)
    const meta = shipMetaOf(log);
    if (!meta.pk.length) return;
    if (!buf.has(t)) buf.set(t, { meta, rows: new Map() });
    const e = buf.get(t);
    if (log.tag === 'delete') { const k = log.key || log.old || {}; e.rows.set(keyText(meta.pk, k), { op: 'D', row: k }); }
    else { const row = rowOf(log); e.rows.set(keyText(meta.pk, row), { op: 'U', row }); }
  });
  // Estado de la suscripción. Antes el fallo de `subscribe` sólo se logueaba a stderr y el
  // proceso seguía vivo mandando latidos 'ok': el 23/08/2026 seis slots quedaron en
  // wal_status='lost' y el monitor mostró los 7 carriles en verde **1.5 días** mientras 5
  // sucursales no ingresaban nada. Un latido tiene que decir si ENTREGA, no si corre.
  // OJO con la semántica: `subscribe()` es de larga duración — su promesa RESUELVE cuando el
  // stream TERMINA, no cuando arranca. Así que no se puede usar el resolve como "está vivo"
  // (probado: reportaba los 7 carriles como caídos). Se marca la MUERTE: rechazo, error del
  // service, o resolución (= el stream se cerró).
  let muerta = null;
  service.on('error', (e) => { muerta = e.message; console.error(`[${code}] error:`, e.message); });

  service.subscribe(plugin, slotName(code))
    .then(() => { muerta = muerta || 'el stream de replicación terminó'; })
    .catch((e) => { muerta = e.message; console.error(`[${code}] subscribe:`, e.message); });

  // CDC.5 — latido → cron_runs (via feeds-ingest). Lee el lag del slot del :5433 (una conexión
  // aparte; la de replicación la tiene el service). db-health hace dead-man's switch: si el
  // consumidor muere y cron_runs se congela → ROJO antes de que el slot llene el disco.
  async function heartbeat() {
    // `status` sale de si el carril PUEDE entregar, no de si el proceso está arriba. Los cuatro
    // modos de muerte silenciosa que había: slot ausente, slot INACTIVO, wal_status='lost'
    // (Postgres lo invalidó por pasarse de max_slot_wal_keep_size) y suscripción caída.
    let note = 'sin slot', status = 'error';
    const c = new Client(localCfg(code));
    try {
      await c.connect();
      const r = (await c.query(`SELECT active, wal_status,
          pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag
        FROM pg_replication_slots WHERE slot_name=$1`, [slotName(code)])).rows[0];
      if (!r) {
        note = `slot ${slotName(code)} NO EXISTE — el carril no está capturando nada`;
      } else {
        const mb = (Number(r.lag) || 0) / 1048576;
        const perdido = ['lost', 'unreserved'].includes(String(r.wal_status));
        note = `lag ${mb.toFixed(1)}MB · ↑U${stats.shipU} ↑D${stats.shipD} · slot ${r.active ? 'activo' : 'INACTIVO'}`
          + ` · wal ${r.wal_status}` + (muerta ? ` · SUSCRIPCIÓN CAÍDA: ${String(muerta).slice(0, 60)}` : '');
        if (perdido) {
          // El WAL de ese periodo ya no existe: reiniciar NO alcanza. Se dice qué hacer.
          note = `slot ${r.wal_status.toUpperCase()} — requiere: ods-cdc-wal.js --drop-slot --branch=${code}`
            + ` + reinicio + backfill (replicate-ods-live.js --branch=${code} --apply). ${note}`;
          status = 'error';
        } else if (!r.active || muerta || mb > WARN_LAG_MB) {
          status = 'error';
        } else {
          status = 'ok';
        }
      }
    } catch (e) { note = `lag n/d: ${String(e.message).slice(0, 40)}`; status = 'error'; }
    finally { await c.end().catch(() => {}); }
    try { await sink.ship('cdc-heartbeat', { rows: [{ job_key: `cdc_wal_${code}`, label: `CDC WAL sucursal ${code}`, status, note, host: 'cdc-lan' }], tenantId: TENANT }); }
    catch (e) { console.error(`[${code}] heartbeat: ${String(e.message).slice(0, 60)}`); }
  }

  if (WATCH) {
    const timer = setInterval(() => flush().catch((e) => console.error('flush:', e.message)), FLUSH_MS);
    heartbeat();
    const hbTimer = setInterval(() => heartbeat(), HEARTBEAT_MS);
    process.on('SIGINT', async () => { clearInterval(timer); clearInterval(hbTimer); await service.stop().catch(() => {}); process.exit(0); });
    // CDC.5.1 — SI LA SUSCRIPCIÓN MUERE, SALIR PARA QUE PM2 REINICIE.
    //
    // Antes `muerta` sólo se anotaba: el proceso seguía vivo para siempre con el stream caído, así
    // que PM2 (que tiene autorestart) nunca veía nada que reiniciar y el slot quedaba INACTIVO
    // acumulando WAL. El único aviso era el heartbeat… que devolvía 404 en las 4 ramas. Los dos
    // canales mudos a la vez. Medido 2026-08-31: sólo 1 de 4 slots activo; 01/05/06 con 2.1 GB de
    // WAL retenido cada una y la 04 ya en `lost` (hueco de 3 días, backfill manual).
    //
    // No se reintenta acá a propósito: reconectar bien (backoff, re-crear slot si se perdió,
    // re-suscribir el plugin) es justo lo que el supervisor ya sabe hacer. Salir con código ≠ 0 es
    // la señal que PM2 entiende.
    const muerteTimer = setInterval(() => {
      if (!muerta) return;
      clearInterval(timer); clearInterval(hbTimer); clearInterval(muerteTimer);
      console.error(`[${code}] SUSCRIPCIÓN CAÍDA: ${muerta} — saliendo para que el supervisor reinicie`);
      service.stop().catch(() => {}).then(() => process.exit(1));
    }, Math.min(FLUSH_MS, 5000));
    console.log(`[${code}] --watch: streaming (flush ${FLUSH_MS}ms · heartbeat ${HEARTBEAT_MS}ms). Ctrl-C para parar.`);
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
