/* eslint-disable no-console */
/**
 * `[CSU.30]` `GET /finance/cortes-sucursales/facturas` por su camino real, contra PROD, sólo lectura.
 *
 *   node database/scripts/csu30-facturas-prod.js [AAAA-MM-DD desde] [AAAA-MM-DD hasta]   (default 2026-11-01 .. 2026-11-25)
 *
 * Como `CortesSucursalesService.facturas`: los cortes del periodo ±1 día con su llegada (consulta de siempre →
 * `armarRespuesta` → las dos consultas del anexo en paralelo → `anexarLlegadaYVenta`), `SQL_FACTURAS_CONTADO`, y
 * `armarFacturas`. Todo cargado tal cual con jiti. Controles del anexo FB (sale con 2 si uno falla), tiempo y peso.
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
const FC = jiti(lib(DIR + 'facturas-de-contado.ts'));

const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
const [from = '2026-11-01', to = '2026-11-25'] = process.argv.slice(2);
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const pg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const masDias = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB (gzip ${(zlib.gzipSync(s).length / 1024).toFixed(0)} KB)`;

async function conectar() {
  const c = new Client({ connectionString: process.env.PROD_DB_URL, application_name: 'csu30-facturas-prod' });
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
  const ok = (cond, txt, extra) => { if (!cond) rojo = true; console.log(`${cond ? 'OK   ' : 'FALLA'} ${txt}${cond || extra === undefined ? '' : `  salió ${JSON.stringify(extra)}`}`); };
  try {
    const rango = { desde: masDias(from, -1), hasta: masDias(to, 1) };
    const t0 = Date.now();
    // Lo que hace list() para el periodo ±1.
    const { filas } = await L.nueva(c, L.sqlNueva(), rango.desde, rango.hasta);
    const resp = E.armarRespuesta(filas, {}, { from: rango.desde, to: rango.hasta });
    const deps = new Map();
    for (const k of resp.cortes) for (const b of k.cobros) {
      const key = `${k.sucursal}|${b.doc_prefix}|${b.folio}`;
      if (!deps.has(key)) deps.set(key, { sucursal: k.sucursal, doc_prefix: b.doc_prefix, folio: b.folio, medio: b.medio_cobro });
    }
    const sucs = [...new Set(resp.cortes.map((k) => k.sucursal))];
    const [ev, ventas] = await Promise.all([
      c2.query(pg(LB.SQL_LLEGADA), LB.parametrosLlegada([...deps.values()], L.TENANT)).then((r) => r.rows),
      c3.query(pg(LC.SQL_VENTA_TURNO), [rango.desde, rango.hasta, sucs]).then((r) => r.rows),
    ]);
    const porLlave = new Map(ev.map((e) => [LB.llaveDeposito(e.sucursal, Number(e.c4), Number(e.c5), e.folio), e]));
    const llegadas = new Map();
    for (const d of deps.values()) {
      const k = LB.llaveDeDocumento(d.doc_prefix);
      llegadas.set(`${d.sucursal}|${d.doc_prefix}|${d.folio}`, LB.clasificarLlegada(d.medio, k ? porLlave.get(LB.llaveDeposito(d.sucursal, k.c4, k.c5, d.folio)) ?? null : null));
    }
    LC.anexarLlegadaYVenta(resp, llegadas, ventas, hoy);
    const msCortes = Date.now() - t0;
    // Lo propio de facturas().
    const t1 = Date.now();
    const crudas = (await c.query(pg(FC.SQL_FACTURAS_CONTADO), FC.parametrosFacturas(from, to, sucs))).rows;
    const facturas = crudas.map(FC.facturaDeContado);
    const msFact = Date.now() - t1;
    const base = { periodo: { from, to }, alcance: { todas: true, sucursales: [] }, sucursal: null, corte: null, rango, llegada_medida: resp.llegada !== null };
    const r = FC.armarFacturas(facturas, resp.cortes, base);
    const r08 = FC.armarFacturas(facturas, resp.cortes, { ...base, sucursal: '08' });
    const rCorte = FC.armarFacturas(facturas, resp.cortes, { ...base, corte: '08-UD2301-0000161' });
    console.log(`periodo ${from}..${to} · cortes ${rango.desde}..${rango.hasta}: ${resp.cortes.length} (${msCortes} ms, con su llegada) · facturas ${facturas.length} (${msFact} ms) → ${r.facturas.length} del periodo`);
    console.log(`peso: toda la red ${kb(JSON.stringify(r))} · Morelia Abastos ${kb(JSON.stringify(r08))}`);

    if (from === '2026-11-01' && to === '2026-11-25') {
      const t12 = r08.tipos.find((t) => t.tipo === 12), t5 = r08.tipos.find((t) => t.tipo === 5);
      ok(t12 && t12.facturas === 246 && t12.monto === 1237163.5 && t12.notas === 4 && t12.notas_monto === 9240.55,
        'Morelia Abastos U-D-12: 246 · $1,237,163.50 · 4 notas −$9,240.55', t12 && { n: t12.facturas, monto: t12.monto, notas: t12.notas, notas_monto: t12.notas_monto });
      ok(t5 && t5.facturas === 251 && t5.monto === 586310.3, 'Morelia Abastos U-D-5: 251 · $586,310.30', t5 && { n: t5.facturas, monto: t5.monto });
      const f = (folio) => r08.facturas.find((x) => x.tipo === 12 && x.folio === folio);
      const c161 = r08.cortes['08-UD2301-0000161'];
      ok(f('0000376')?.corte === '08-UD2301-0000161' && c161?.llegada?.estado === 'llego' && c161?.venta_sin_forma_de_pago === 89436.19,
        '0000376 → corte 0000161: llegó, venta sin forma de pago $89,436.19', { corte: f('0000376')?.corte, llegada: c161?.llegada?.estado, vsfp: c161?.venta_sin_forma_de_pago });
      ok(f('0000471')?.sin_corte === 'otro_periodo', '0000471 → «otro periodo» (ticket del 6-oct)', f('0000471')?.sin_corte);
      ok(f('0000539')?.sin_corte === 'antes_del_corte_pos', '0000539 → «antes del corte POS»', f('0000539')?.sin_corte);
      const fc = rCorte.facturas.filter((x) => x.tipo === 12).map((x) => x.folio);
      ok(['0000373', '0000374', '0000376'].every((x) => fc.includes(x)), `con corte=0000161: sus facturas del turno (${fc.join(', ')})`);
    }
    // Invariantes: toda factura con corte apunta a un corte del mapa; la suma por estado = la del tipo.
    ok(r.facturas.every((x) => (x.corte === null) !== (x.sin_corte === null) && (!x.corte || r.cortes[x.corte])), 'cada factura tiene corte o por qué no, y su corte está en el mapa');
    ok(r.tipos.every((t) => Object.values(t.por_corte).reduce((s, v) => s + v.facturas, 0) === t.facturas), 'por tipo, la suma de estados = las facturas');
    for (const t of r.tipos) {
      const e = Object.entries(t.por_corte).filter(([, v]) => v.facturas).map(([k, v]) => `${k} ${v.facturas}`).join(' · ');
      console.log(`  ${t.tipo} ${t.tipo_nombre}: ${t.facturas} · $${t.monto.toLocaleString('es-MX')} · ${t.notas} notas −$${t.notas_monto.toLocaleString('es-MX')} → ${e}`);
    }
  } finally {
    for (const x of [c, c2, c3]) { await x.query('ROLLBACK').catch(() => { /* la transacción ya pudo cerrarse con el error: no hay nada que deshacer */ }); await x.end(); }
  }
  if (rojo) { console.log('\n⛔ un control falló'); process.exit(2); }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
