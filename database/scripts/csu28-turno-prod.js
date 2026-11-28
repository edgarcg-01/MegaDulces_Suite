/* eslint-disable no-console */
/**
 * `[CSU.28]` La venta del turno y las facturas de contado, contra PROD, sólo lectura.
 *
 *   node database/scripts/csu28-turno-prod.js [AAAA-MM-DD desde] [AAAA-MM-DD hasta]   (default 2026-11-01 .. 2026-11-25)
 *
 * El camino REAL (jiti, no copias): cortes y cobros del servicio, `construirCorte`, `SQL_VENTA_TURNO` +
 * `ventaDelTurno`, `SQL_FACTURAS_CONTADO` + `facturaDeContado` + `corteDeFactura` + `ventaDelTurnoDetalle`.
 * Los cortes se leen desde el 25-sep: una factura del periodo puede venir de un ticket de hasta 83 días antes.
 * Controles del anexo FB (sale con 2 si uno falla) y la cobertura de las facturas por su corte.
 * Candados: clúster de prod por `system_identifier`, READ ONLY, statement_timeout, ROLLBACK. Lee `PROD_DB_URL`.
 */
const path = require('path');
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
const LC = jiti(lib(DIR + 'llegada-del-corte.ts'));
const FC = jiti(lib(DIR + 'facturas-de-contado.ts'));

const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
const [from = '2026-11-01', to = '2026-11-25'] = process.argv.slice(2);
const DESDE_CORTES = '2026-09-25';
const pg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const fmt = (n) => (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dias = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en .env');
  const c = new Client({ connectionString: process.env.PROD_DB_URL, application_name: 'csu28-turno-prod' });
  await c.connect();
  let rojo = false;
  const ok = (cond, txt, extra) => { if (!cond) rojo = true; console.log(`${cond ? 'OK   ' : 'FALLA'} ${txt}${cond || extra === undefined ? '' : `  salió ${JSON.stringify(extra)}`}`); };
  try {
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== PROD_CLUSTER_ID) throw new Error(`el clúster ${id} NO es prod (${PROD_CLUSTER_ID})`);
    await c.query('BEGIN TRANSACTION READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '60s'`);
    const { filas } = await L.nueva(c, L.sqlNueva(), DESDE_CORTES, to);
    const cortes = filas.map((f) => E.construirCorte(f, {})).filter((k) => k.monto >= E.MONTO_MINIMO_CORTE);
    const sucs = [...new Set(cortes.map((k) => k.sucursal))];
    let t0 = Date.now();
    const ventas = (await c.query(pg(LC.SQL_VENTA_TURNO), [from, to, sucs])).rows;
    const msVenta = Date.now() - t0;
    t0 = Date.now();
    const crudas = (await c.query(pg(FC.SQL_FACTURAS_CONTADO), FC.parametrosFacturas(from, to, sucs))).rows;
    const msFact = Date.now() - t0;
    const facturas = crudas.map(FC.facturaDeContado);
    console.log(`cortes ${DESDE_CORTES}..${to}: ${cortes.length} · venta por turno ${ventas.length} grupos (${msVenta} ms) · facturas ${facturas.length} (${msFact} ms)`);

    const corte = (suc, folio) => cortes.find((k) => k.sucursal === suc && k.folio === folio);
    const fac = (suc, folio, tipo = 12) => facturas.find((f) => f.sucursal === suc && f.folio === folio && f.tipo === tipo);
    const k161 = corte('08', '0000161');
    const otros = (k) => cortes.filter((o) => o !== k && o.sucursal === k.sucursal && o.caja === k.caja && o.turno === k.turno && Math.abs(dias(o.fecha, k.fecha)) <= 3).length;
    const d161 = k161 && FC.ventaDelTurnoDetalle(k161, LC.ventaDelTurno(k161, ventas, otros(k161)), facturas);
    ok(d161 && d161.tickets === 118 && d161.total === 182383.1 && d161.devoluciones === 8751.25 && d161.neto === 173631.85 && d161.igual_al_corte,
      '0000161: 118 tickets $182,383.10 − $8,751.25 = $173,631.85, igual al corte', d161 && { ...d161, facturas: d161.facturas.length });
    const f161 = d161 ? d161.facturas.filter((f) => f.tipo === 12).map((f) => f.folio) : [];
    ok(['0000373', '0000374', '0000376'].every((x) => f161.includes(x)), `0000161: facturas Cont No Fiscal del turno 0000373, 0000374, 0000376 (salen: ${f161.join(', ')})`);
    const f376 = fac('08', '0000376');
    ok(f376 && f376.notas.length === 1 && f376.notas[0].folio === '0000017' && f376.notas[0].monto === 8392.25 && f376.neto === 57694.49,
      '0000376: nota UA2501-0000017 −$8,392.25, neto $57,694.49', f376 && f376.notas);
    for (const [folio, esperado] of [['0000379', '0000163'], ['0000380', '0000163'], ['0000471', '0000024']]) {
      const r = fac('08', folio) && FC.corteDeFactura(fac('08', folio), cortes);
      ok(r && r.corte && r.corte.folio === esperado, `${folio} → corte ${esperado}`, r && { corte: r.corte && r.corte.folio, por_que: r.por_que });
    }
    const r539 = fac('08', '0000539') && FC.corteDeFactura(fac('08', '0000539'), cortes);
    ok(r539 && r539.por_que === 'antes_del_corte_pos', '0000539 → antes del corte POS (ticket del 30-sep)', r539 && r539.por_que);

    // Testigo independiente: el conteo por tipo de la consulta directa a kdm1 del 2026-11-26 (Morelia Abastos, 1–25 nov).
    const delPeriodo = facturas.filter((f) => f.fecha >= from && f.fecha <= to);
    const s08 = (tipo) => delPeriodo.filter((f) => f.sucursal === '08' && f.tipo === tipo);
    const sum = (xs, k) => Math.round(xs.reduce((t, x) => t + x[k], 0) * 100) / 100;
    if (from === '2026-11-01' && to === '2026-11-25') {
      ok(s08(12).length === 246 && sum(s08(12), 'total') === 1237163.5 && s08(12).filter((f) => f.notas.length).length === 4 && sum(s08(12), 'notas_total') === 9240.55,
        'Morelia Abastos U-D-12: 246 · $1,237,163.50 · 4 notas −$9,240.55 (= la consulta directa)', { n: s08(12).length, total: sum(s08(12), 'total'), notas: sum(s08(12), 'notas_total') });
      ok(s08(5).length === 251 && sum(s08(5), 'total') === 586310.3, 'Morelia Abastos U-D-5: 251 · $586,310.30 (= la consulta directa)', { n: s08(5).length, total: sum(s08(5), 'total') });
    }

    // Cobertura: el corte de cada factura del periodo.
    const porQue = {};
    for (const f of delPeriodo) { const r = FC.corteDeFactura(f, cortes); const k = r.por_que ?? 'con_corte'; const p = porQue[k] || (porQue[k] = { n: 0, total: 0 }); p.n++; p.total += f.total; }
    console.log(`\nfacturas de contado del periodo (por fecha de factura): ${delPeriodo.length}`);
    for (const [k, p] of Object.entries(porQue)) console.log(`  ${k.padEnd(20)} ${String(p.n).padStart(5)}  $${fmt(p.total)}`);
    const porTipo = {};
    for (const f of delPeriodo) { const k = `${f.tipo} ${f.tipo_nombre}`; const p = porTipo[k] || (porTipo[k] = { n: 0, total: 0, notas: 0, notasN: 0 }); p.n++; p.total += f.total; p.notas += f.notas_total; p.notasN += f.notas.length; }
    for (const [k, p] of Object.entries(porTipo)) console.log(`  tipo ${k.padEnd(28)} ${String(p.n).padStart(5)}  $${fmt(p.total)}  · ${p.notasN} notas −$${fmt(p.notas)}`);
    // Ninguna factura en dos cortes.
    const enCortes = new Map();
    for (const k of cortes.filter((x) => x.fecha >= from && x.fecha <= to)) for (const f of FC.facturasDelTurno(k, facturas)) {
      const key = `${f.sucursal}|${f.tipo}|${f.folio}`; enCortes.set(key, (enCortes.get(key) || 0) + 1);
    }
    const dobles = [...enCortes.values()].filter((n) => n > 1).length;
    ok(dobles === 0, `ninguna factura cae en dos cortes (${enCortes.size} facturas en cortes del periodo; dobles: ${dobles})`);
  } finally {
    await c.query('ROLLBACK').catch(() => { /* la transacción ya pudo cerrarse con el error: no hay nada que deshacer */ });
    await c.end();
  }
  if (rojo) { console.log('\n⛔ un control falló'); process.exit(2); }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
