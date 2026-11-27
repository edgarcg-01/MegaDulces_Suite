/* eslint-disable no-console */
/**
 * `[CSU.27]` ¿Llegó el dinero de cada corte, y cuáles son venta sin forma de pago? Contra PROD, sólo lectura.
 *
 *   node database/scripts/csu27-corte-prod.js [AAAA-MM-DD desde] [AAAA-MM-DD hasta]   (default 2026-11-01 .. 2026-11-25)
 *
 * El camino REAL, cargado tal cual (jiti), no copias: la consulta de cortes y de cobros del servicio
 * (`_lib/csu-cortes-sql`), `construirCorte` del motor, `SQL_LLEGADA` + `clasificarLlegada` (CSU.26) y
 * `SQL_VENTA_TURNO` + `ventaDelTurno` + `ventaSinFormaDePago` + `llegadaDelCorte` (CSU.27).
 * Imprime los CONTROLES del anexo FB (sale con 2 si uno falla), la propiedad «sin depósito ⇔ sin cobros», y la
 * métrica 2 (venta sin forma de pago) y el estado de los cortes por sucursal.
 * Candados: clúster de prod por `system_identifier`, READ ONLY, statement_timeout, ROLLBACK. Lee `PROD_DB_URL`.
 */
const path = require('path');
const L = require('./_lib/csu-cortes-sql');
require('dotenv').config({ path: path.join(L.REPO, '.env'), quiet: true });
const { Client } = require('pg');
const lib = (p) => path.join(L.REPO, 'libs', p);
// El motor importa del paquete sólo piezas puras: se resuelven a SUS archivos, no al índice entero.
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
const fmt = (n) => (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dias = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

/** Los controles del anexo FB, medidos el 2026-11-26. */
const CONTROLES = [
  { suc: '08', folio: '0000161', ver: (k) => k.llegada.estado === 'llego' && k.venta_sin_forma_de_pago === 89436.19 && k.venta?.tickets === 118, dice: 'llegó + venta sin forma de pago $89,436.19 (118 tickets)' },
  { suc: '08', folio: '0000165', ver: (k) => k.llegada.estado === 'sin_conciliar' && k.llegada.sin_conciliar === 8335.54, dice: 'sin conciliar $8,335.54 (UA0501-0000401)' },
  { suc: '08', folio: '0000163', ver: (k) => k.llegada.estado === 'llego', dice: 'llegó (Caja General + Santander 1604)' },
  { suc: '05', folio: '0000154', ver: (k) => k.cuadre === 'corte_distinto' && k.venta_sin_forma_de_pago === null, dice: '«Corte distinto» SIN causa: el corte no es la venta del turno' },
];

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en .env');
  const c = new Client({ connectionString: process.env.PROD_DB_URL, application_name: 'csu27-corte-prod' });
  await c.connect();
  let rojo = false;
  try {
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== PROD_CLUSTER_ID) throw new Error(`el clúster ${id} NO es prod (${PROD_CLUSTER_ID})`);
    await c.query('BEGIN TRANSACTION READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '60s'`);
    const { filas, ms } = await L.nueva(c, L.sqlNueva(), from, to);
    const cortes = filas.map((f) => E.construirCorte(f, {})).filter((k) => k.monto >= E.MONTO_MINIMO_CORTE);

    const deps = new Map();
    for (const k of cortes) for (const x of k.cobros) {
      const key = `${k.sucursal}|${x.doc_prefix}|${x.folio}`;
      if (!deps.has(key)) deps.set(key, { sucursal: k.sucursal, doc_prefix: x.doc_prefix, folio: x.folio, medio: x.medio_cobro });
    }
    let t0 = Date.now();
    const ev = (await c.query(pg(LB.SQL_LLEGADA), LB.parametrosLlegada([...deps.values()], L.TENANT))).rows;
    const msLlegada = Date.now() - t0;
    const porLlave = new Map(ev.map((e) => [LB.llaveDeposito(e.sucursal, e.c4, e.c5, e.folio), e]));
    for (const d of deps.values()) {
      const k = LB.llaveDeDocumento(d.doc_prefix);
      d.llegada = LB.clasificarLlegada(d.medio, k ? porLlave.get(LB.llaveDeposito(d.sucursal, k.c4, k.c5, d.folio)) ?? null : null);
    }
    t0 = Date.now();
    const ventas = (await c.query(pg(LC.SQL_VENTA_TURNO), [from, to, [...new Set(cortes.map((k) => k.sucursal))]])).rows;
    const msVenta = Date.now() - t0;
    for (const k of cortes) {
      const otros = cortes.filter((o) => o !== k && o.sucursal === k.sucursal && o.caja === k.caja && o.turno === k.turno && Math.abs(dias(o.fecha, k.fecha)) <= 3).length;
      k.venta = LC.ventaDelTurno(k, ventas, otros);
      k.venta_sin_forma_de_pago = LC.ventaSinFormaDePago(k, k.venta);
      k.llegada = LC.llegadaDelCorte(k, k.cobros.map((x) => ({ monto: x.monto, llegada: deps.get(`${k.sucursal}|${x.doc_prefix}|${x.folio}`).llegada })), hoy);
    }
    console.log(`periodo ${from}..${to} (hoy ${hoy}) · ${cortes.length} cortes (${ms} ms) · ${deps.size} depósitos (llegada ${msLlegada} ms) · venta por turno ${ventas.length} grupos (${msVenta} ms)`);

    for (const ctl of CONTROLES) {
      const k = cortes.find((x) => x.sucursal === ctl.suc && x.folio === ctl.folio);
      const ok = !!k && ctl.ver(k);
      if (!ok) rojo = true;
      console.log(`${ok ? 'OK   ' : 'FALLA'} ${ctl.suc} ${ctl.folio} → ${ctl.dice}` + (ok ? '' : `  salió ${JSON.stringify(k ? { cuadre: k.cuadre, venta: k.venta, vsfp: k.venta_sin_forma_de_pago, llegada: k.llegada } : null)}`));
    }
    // Propiedad: «sin depósito» exactamente cuando Kepler no le aplicó nada.
    const malSinDep = cortes.filter((k) => (k.llegada.estado === 'sin_deposito') !== (k.cobros.reduce((t, x) => t + x.monto, 0) < 1));
    if (malSinDep.length) rojo = true;
    console.log(`${malSinDep.length ? 'FALLA' : 'OK   '} «sin depósito» ⇔ sin cobros aplicados (${malSinDep.length} fuera)`);

    // Métrica 2: venta sin forma de pago, con testigo.
    const vsfp = cortes.filter((k) => k.venta_sin_forma_de_pago !== null);
    const distintoArriba = cortes.filter((k) => k.cuadre === 'corte_distinto' && k.diferencia > 0);
    const conVenta = cortes.filter((k) => k.venta && Math.abs(k.venta.total - k.devoluciones_total - k.monto) < 1).length;
    console.log(`\ncorte = venta del turno − devoluciones: ${conVenta} de ${cortes.length}`);
    console.log(`«Corte distinto» arriba de lo esperado: ${distintoArriba.length} · venta sin forma de pago (con testigo): ${vsfp.length} · $${fmt(vsfp.reduce((t, k) => t + k.venta_sin_forma_de_pago, 0))}`);
    for (const k of distintoArriba.filter((x) => x.venta_sin_forma_de_pago === null)) console.log(`   sin causa: ${k.sucursal} ${k.folio} ${k.referencia} ${k.fecha} +${fmt(k.diferencia)}`);

    // Estado de los cortes, por sucursal.
    const estados = ['llego', 'por_saber', 'parcial', 'sin_conciliar', 'sin_deposito'];
    const S = {};
    for (const k of cortes) {
      for (const key of [k.sucursal, 'RED']) {
        const s = S[key] || (S[key] = { n: 0, vsfp: 0, edadMax: 0 });
        s.n++; s[k.llegada.estado] = (s[k.llegada.estado] || 0) + 1;
        if (k.venta_sin_forma_de_pago !== null) s.vsfp++;
        if (k.llegada.edad_dias !== null) s.edadMax = Math.max(s.edadMax, k.llegada.edad_dias);
      }
    }
    console.log(`\n${'suc'.padEnd(4)} ${'cortes'.padStart(6)} ${estados.map((e) => e.padStart(14)).join('')} ${'sin forma pago'.padStart(15)} ${'días sin dep.'.padStart(14)}`);
    for (const [key, s] of Object.entries(S).sort((a, b) => (a[0] === 'RED') - (b[0] === 'RED') || a[0].localeCompare(b[0]))) {
      console.log(`${key.padEnd(4)} ${String(s.n).padStart(6)} ${estados.map((e) => String(s[e] || 0).padStart(14)).join('')} ${String(s.vsfp).padStart(15)} ${String(s.edadMax).padStart(14)}`);
    }
  } finally {
    await c.query('ROLLBACK').catch(() => { /* la transacción ya pudo cerrarse con el error: no hay nada que deshacer */ });
    await c.end();
  }
  if (rojo) { console.log('\n⛔ un control falló'); process.exit(2); }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
