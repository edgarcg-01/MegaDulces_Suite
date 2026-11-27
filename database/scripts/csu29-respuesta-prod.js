/* eslint-disable no-console */
/**
 * `[CSU.29]` La respuesta de Cortes / Sucursales con el anexo FB colgado, contra PROD, sólo lectura.
 *
 *   node database/scripts/csu29-respuesta-prod.js [AAAA-MM-DD desde] [AAAA-MM-DD hasta]   (default 2026-11-01 .. 2026-11-25)
 *
 * El camino del servicio, cargado tal cual (jiti): consulta de cortes y cobros (`_lib/csu-cortes-sql`) →
 * `armarRespuesta` → EN PARALELO, en dos conexiones (como `anexarFacturaAlBanco`), `SQL_LLEGADA` y `SQL_VENTA_TURNO`
 * → `anexarLlegadaYVenta`. Mide:
 *  · el peso de la respuesta antes y después (JSON y gzip) — criterio de CSU.29;
 *  · el tiempo del anexo (las dos consultas en paralelo);
 *  · las invariantes: en cada corte, llegó + por saber + sin conciliar + puente = aplicado, y aplicado + sin depósito
 *    = monto cuando no está sobreaplicado; y los controles del anexo.
 * Candados: clúster de prod por `system_identifier`, READ ONLY, statement_timeout, ROLLBACK. Lee `PROD_DB_URL`.
 */
const path = require('path');
const zlib = require('zlib');
const L = require('./_lib/csu-cortes-sql');
require('dotenv').config({ path: path.join(L.REPO, '.env'), quiet: true });
const { Client } = require('pg');
const lib = (p) => path.join(L.REPO, 'libs', p);
const jiti = require(path.join(L.REPO, 'node_modules/jiti'))(__filename, { alias: {
  '@megadulces/contracts': lib('contracts/src/money/denominations.ts'),
  '@megadulces/platform-core': lib('platform-core/src/lib/caja/cash-cut-identity.ts'),
} });
const DIR = 'finance/src/lib/cortes-sucursales/';
const E = jiti(lib(DIR + 'cortes-sucursales.engine.ts'));
const LB = jiti(lib(DIR + 'llegada-al-banco.ts'));
const LC = jiti(lib(DIR + 'llegada-del-corte.ts'));

const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
const [from = '2026-11-01', to = '2026-11-25'] = process.argv.slice(2);
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const pg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB (gzip ${(zlib.gzipSync(s).length / 1024).toFixed(0)} KB)`;

async function conectar() {
  const c = new Client({ connectionString: process.env.PROD_DB_URL, application_name: 'csu29-respuesta-prod' });
  await c.connect();
  const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  if (id !== PROD_CLUSTER_ID) throw new Error(`el clúster ${id} NO es prod (${PROD_CLUSTER_ID})`);
  await c.query('BEGIN TRANSACTION READ ONLY');
  await c.query(`SET LOCAL statement_timeout = '60s'`);
  return c;
}

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en .env');
  const [c, c2, c3] = await Promise.all([conectar(), conectar(), conectar()]);
  let rojo = false;
  const ok = (cond, txt) => { if (!cond) rojo = true; console.log(`${cond ? 'OK   ' : 'FALLA'} ${txt}`); };
  try {
    const t0 = Date.now();
    const { filas } = await L.nueva(c, L.sqlNueva(), from, to);
    const resp = E.armarRespuesta(filas, {}, { from, to });
    const msBase = Date.now() - t0;
    const antes = JSON.stringify(resp);

    // Como `anexarFacturaAlBanco`: los depósitos únicos y las sucursales, y las dos consultas en paralelo.
    const deps = new Map();
    for (const k of resp.cortes) for (const b of k.cobros) {
      const key = `${k.sucursal}|${b.doc_prefix}|${b.folio}`;
      if (!deps.has(key)) deps.set(key, { sucursal: k.sucursal, doc_prefix: b.doc_prefix, folio: b.folio, medio: b.medio_cobro });
    }
    const sucs = [...new Set(resp.cortes.map((k) => k.sucursal))];
    const t1 = Date.now();
    const [ev, ventas] = await Promise.all([
      c2.query(pg(LB.SQL_LLEGADA), LB.parametrosLlegada([...deps.values()], L.TENANT)).then((r) => r.rows),
      c3.query(pg(LC.SQL_VENTA_TURNO), [from, to, sucs]).then((r) => r.rows),
    ]);
    const msAnexoSql = Date.now() - t1;
    const porLlave = new Map(ev.map((e) => [LB.llaveDeposito(e.sucursal, Number(e.c4), Number(e.c5), e.folio), e]));
    const llegadas = new Map();
    for (const d of deps.values()) {
      const k = LB.llaveDeDocumento(d.doc_prefix);
      llegadas.set(`${d.sucursal}|${d.doc_prefix}|${d.folio}`, LB.clasificarLlegada(d.medio, k ? porLlave.get(LB.llaveDeposito(d.sucursal, k.c4, k.c5, d.folio)) ?? null : null));
    }
    const t2 = Date.now();
    LC.anexarLlegadaYVenta(resp, llegadas, ventas, hoy);
    const msAnexoJs = Date.now() - t2;
    const despues = JSON.stringify(resp);

    console.log(`periodo ${from}..${to} (hoy ${hoy}) · ${resp.cortes.length} cortes · ${deps.size} depósitos`);
    console.log(`tiempo: respuesta de siempre ${msBase} ms · anexo, dos consultas en paralelo ${msAnexoSql} ms + armado ${msAnexoJs} ms`);
    console.log(`peso: antes ${kb(antes)} → después ${kb(despues)}`);

    const k161 = resp.cortes.find((k) => k.sucursal === '08' && k.folio === '0000161');
    if (k161) {
      ok(k161.cobros.length === 4 && k161.cobros.every((b) => b.llegada && b.llegada.estado === 'en_banco'), '0000161: sus 4 depósitos, en el banco');
      ok(k161.llegada && k161.llegada.estado === 'llego' && k161.venta_sin_forma_de_pago === 89436.19 && k161.venta_turno && k161.venta_turno.tickets === 118,
        '0000161: llegó, venta sin forma de pago $89,436.19, 118 tickets');
    }
    // Invariantes por corte.
    let malSuma = 0, malMonto = 0;
    for (const k of resp.cortes) {
      const aplicado = k.cobros.reduce((t, b) => t + b.monto, 0);
      const l = k.llegada;
      if (Math.abs(l.llego + l.por_saber + l.sin_conciliar + l.puente - aplicado) > 0.02) malSuma++;
      if (aplicado <= k.monto && Math.abs(aplicado + l.sin_deposito - k.monto) > 0.02) malMonto++;
    }
    ok(malSuma === 0, `en cada corte, llegó + por saber + sin conciliar + puente = aplicado (${malSuma} fuera)`);
    ok(malMonto === 0, `en cada corte, aplicado + sin depósito = monto (${malMonto} fuera)`);
    const L2 = resp.llegada;
    ok(L2 && Math.abs(L2.aplicado - (L2.llego + L2.por_saber + L2.sin_conciliar + L2.puente)) < 0.05, 'el resumen del periodo suma lo aplicado');
    console.log(`\nresumen: aplicado $${L2.aplicado.toLocaleString('es-MX')} · llegó $${L2.llego.toLocaleString('es-MX')} (${(100 * L2.llego / L2.aplicado).toFixed(1)} %) · por saber $${L2.por_saber.toLocaleString('es-MX')} · sin conciliar $${L2.sin_conciliar.toLocaleString('es-MX')} · sin depósito $${L2.sin_deposito.toLocaleString('es-MX')}`);
    console.log(`cortes por estado: ${JSON.stringify(L2.cortes)} · venta sin forma de pago: ${JSON.stringify(resp.venta_sin_forma_de_pago)}`);
  } finally {
    for (const x of [c, c2, c3]) { await x.query('ROLLBACK').catch(() => { /* la transacción ya pudo cerrarse con el error: no hay nada que deshacer */ }); await x.end(); }
  }
  if (rojo) { console.log('\n⛔ un control falló'); process.exit(2); }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
