/* eslint-disable no-console */
/**
 * `[CSU.26]` ¿Dónde está cada depósito aplicado a un corte? Contra PROD, sólo lectura.
 *
 *   node database/scripts/csu26-llegada-prod.js [AAAA-MM-DD desde] [AAAA-MM-DD hasta]   (default 2026-11-01 .. 2026-11-25)
 *
 * Corre el camino REAL: la consulta de cortes y la de cobros del servicio (sacadas de su .ts, `_lib/csu-cortes-sql`),
 * y `SQL_LLEGADA` + `clasificarLlegada` cargados TAL CUAL con jiti (no una copia). Después:
 *  1. los CONTROLES con respuesta conocida (anexo FB §1) — si uno falla, sale con código 2;
 *  2. la métrica 1 del anexo: pesos aplicados por clase, por sucursal y de la red;
 *  3. el tiempo de la consulta nueva.
 * Candados: clúster de prod por `system_identifier`, transacción READ ONLY, statement_timeout, ROLLBACK.
 * Lee `PROD_DB_URL` del `.env`.
 */
const path = require('path');
const L = require('./_lib/csu-cortes-sql');
require('dotenv').config({ path: path.join(L.REPO, '.env'), quiet: true });
const { Client } = require('pg');
const jiti = require(path.join(L.REPO, 'node_modules/jiti'))(__filename);
const M = jiti(path.join(L.REPO, 'libs/finance/src/lib/cortes-sucursales/llegada-al-banco.ts'));

const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
const [from = '2026-11-01', to = '2026-11-25'] = process.argv.slice(2);
const pg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const fmt = (n) => (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Los controles del anexo FB §1, medidos a mano el 2026-11-26. */
const CONTROLES = [
  { suc: '08', doc: 'UA0501', folio: '0000363', estado: 'en_banco', ver: (l) => l.renglones.some((r) => r.cuenta === 'STDR 1604' && r.fecha === '2026-11-03' && r.monto === 8600) },
  { suc: '08', doc: 'UA0501', folio: '0000366', estado: 'en_caja_general', ver: (l) => l.caja_general.some((a) => a.entrada === 'CI-2026-00343' && a.corte === 'CC-2026-00023') },
  { suc: '08', doc: 'UA0501', folio: '0000538', estado: 'banco_sin_libro', ver: (l) => l.cuenta_bancos === 'STDR 1604' && l.libro_hasta === '2026-11-10' },
  { suc: '08', doc: 'UA0501', folio: '0000401', estado: 'sin_conciliar', ver: (l) => l.cuenta === '4176' && l.renglones.length === 0 },
  { suc: '01', doc: 'UA0501', folio: '0000495', estado: 'puente', ver: () => true },
];

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en .env');
  const c = new Client({ connectionString: process.env.PROD_DB_URL, application_name: 'csu26-llegada-prod' });
  await c.connect();
  let rojo = false;
  try {
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== PROD_CLUSTER_ID) throw new Error(`el clúster ${id} NO es prod (${PROD_CLUSTER_ID})`);
    await c.query('BEGIN TRANSACTION READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '60s'`);
    const { filas, ms } = await L.nueva(c, L.sqlNueva(), from, to);

    // Los depósitos únicos (uno puede estar aplicado a varios cortes) y su clase de cuenta (CSU.8).
    const deps = new Map();
    for (const f of filas) for (const x of f.cobros || []) {
      const k = `${f.sucursal}|${x.doc_prefix}|${x.folio}`;
      if (!deps.has(k)) deps.set(k, { sucursal: f.sucursal, doc_prefix: x.doc_prefix, folio: x.folio, medio: x.medio_cobro });
    }
    const t0 = Date.now();
    const ev = (await c.query(pg(M.SQL_LLEGADA), M.parametrosLlegada([...deps.values()], L.TENANT))).rows;
    const msLlegada = Date.now() - t0;
    const porLlave = new Map(ev.map((e) => [M.llaveDeposito(e.sucursal, e.c4, e.c5, e.folio), e]));
    for (const d of deps.values()) {
      const k = M.llaveDeDocumento(d.doc_prefix);
      d.llegada = M.clasificarLlegada(d.medio, k ? porLlave.get(M.llaveDeposito(d.sucursal, k.c4, k.c5, d.folio)) ?? null : null);
    }
    console.log(`periodo ${from}..${to} · ${filas.length} cortes (${ms} ms) · ${deps.size} depósitos · SQL_LLEGADA ${ev.length} filas en ${msLlegada} ms`);

    for (const ctl of CONTROLES) {
      const d = deps.get(`${ctl.suc}|${ctl.doc}|${ctl.folio}`);
      const ok = !!d && d.llegada.estado === ctl.estado && ctl.ver(d.llegada);
      if (!ok) rojo = true;
      console.log(`${ok ? 'OK   ' : 'FALLA'} ${ctl.suc} ${ctl.doc}-${ctl.folio} → esperado ${ctl.estado}, salió ${d ? d.llegada.estado : 'NO ESTÁ EN EL PERIODO'}`
        + (ok ? '' : `  ${JSON.stringify(d?.llegada ?? null)}`));
    }

    // Métrica 1: pesos APLICADOS a los cortes, por clase del depósito (un depósito repartido cuenta lo que aplicó a cada corte).
    const S = {}, RED = { aplicado: 0 };
    for (const f of filas) for (const x of f.cobros || []) {
      const e = deps.get(`${f.sucursal}|${x.doc_prefix}|${x.folio}`).llegada.estado;
      const s = S[f.sucursal] || (S[f.sucursal] = { aplicado: 0 });
      for (const X of [s, RED]) { X[e] = (X[e] || 0) + Number(x.monto); X.aplicado += Number(x.monto); }
    }
    const clases = ['en_banco', 'en_caja_general', 'banco_sin_libro', 'sin_conciliar', 'caja_sin_asiento', 'puente', 'sin_cuenta'];
    console.log(`\n${'suc'.padEnd(4)} ${'aplicado'.padStart(15)} ${clases.map((k) => k.padStart(16)).join(' ')}   llegó`);
    for (const [k, X] of [...Object.entries(S).sort(), ['RED', RED]]) {
      const llego = (X.en_banco || 0) + (X.en_caja_general || 0);
      console.log(`${k.padEnd(4)} ${fmt(X.aplicado).padStart(15)} ${clases.map((cl) => fmt(X[cl]).padStart(16)).join(' ')}   ${(100 * llego / (X.aplicado || 1)).toFixed(1)} %`);
    }
    // Lo que todavía no se puede decir, o no se concilió: ¿en qué cuenta de Bancos, y hasta dónde llega su libro?
    for (const clase of ['banco_sin_libro', 'sin_conciliar']) {
      const por = {};
      for (const f of filas) for (const x of f.cobros || []) {
        const l = deps.get(`${f.sucursal}|${x.doc_prefix}|${x.folio}`).llegada;
        if (l.estado !== clase) continue;
        const k = `${l.cuenta_bancos ?? `(Kepler ${l.cuenta}, sin cuenta en Bancos)`} · libro hasta ${l.libro_hasta ?? '—'}`;
        por[k] = (por[k] || 0) + Number(x.monto);
      }
      console.log(`\n${clase}:`);
      for (const [k, v] of Object.entries(por).sort((a, b) => b[1] - a[1])) console.log(`  ${fmt(v).padStart(15)}  ${k}`);
    }
    const debiles = [...deps.values()].filter((d) => d.llegada.renglones.some((r) => r.debil)).length;
    console.log(`\ndepósitos en_banco con pase débil (la pantalla dice «probable»): ${debiles}`);
  } finally {
    await c.query('ROLLBACK').catch(() => { /* la transacción ya pudo cerrarse con el error: no hay nada que deshacer */ });
    await c.end();
  }
  if (rojo) { console.log('\n⛔ un control falló'); process.exit(2); }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
