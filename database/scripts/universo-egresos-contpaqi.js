#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.83]` — **El universo: cada póliza de egreso que capturó la contadora, y qué hace el puente con ella.**
 *
 * `comparar-armado-contpaqi.js` mide desde NUESTRO lado: lo que el puente arma, ¿sale igual? Eso es precisión, y
 * dejó afuera todo lo que el puente no arma — la póliza de Oscar Hernández («Mant. de equipo de reparto»,
 * 21/sep/2026) no estaba en la prueba porque el puente no la toca. Esto mide desde el lado de ELLA:
 *
 *   cada póliza tipo 2 de ContPAQi → su(s) renglón(es) de banco → el movimiento de banco (cuenta, importe, ±3 días)
 *   → lo que el puente hace con ese movimiento (`construirLotes`: entra, o el motivo por el que no).
 *
 * Y de cada póliza, a qué rubro carga (gasto 52xx, proveedor 2120/50x0, tarjeta 2140, …) y si lleva CFDI.
 *
 *   node database/scripts/universo-egresos-contpaqi.js --desde=2026-01 --hasta=2026-09 [--json=salida.json]
 *
 * Sólo lectura, verifica `system_identifier`.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const ALIAS = { '@megadulces/contracts': path.join(ROOT, 'libs/contracts/src/index.ts') };
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(p, ...resto) { return ALIAS[p] ? ALIAS[p] : resolveOriginal.call(this, p, ...resto); };
const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'contpaqi');
const { ContpaqiArmadoService } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));

const PROD = '7688376744939610156';
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const arg = (n, d) => { const p = process.argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.split('=').slice(1).join('=') : d; };
const DESDE = arg('desde', '2026-01'); const HASTA = arg('hasta', DESDE); const JSON_OUT = arg('json', null);
function meses(d, h) { const o = []; let [y, m] = d.split('-').map(Number); const [yh, mh] = h.split('-').map(Number); while (y < yh || (y === yh && m <= mh)) { o.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } } return o; }
const cent = (n) => Math.round(Number(n) * 100);
const dias = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

/** El rubro de la póliza: lo que carga, sin contar banco ni impuestos. */
function rubro(cargos) {
  const c = cargos.map((x) => x.cuenta).filter((x) => !/^(102|1060|1470|1050)/.test(x));
  if (!c.length) return 'solo_impuestos_o_banco';
  const fam = (re) => c.some((x) => re.test(x));
  if (fam(/^(2120|50[12]0)/)) return 'proveedor (2120/5010/5020)';
  if (fam(/^2140/)) return 'tarjeta (2140)';
  if (fam(/^52/)) return 'gasto (52xx)';
  if (fam(/^(10[1-9]|11)/)) return 'traspaso/activo (10x-11x)';
  if (fam(/^2/)) return 'pasivo (2xxx)';
  if (fam(/^5/)) return 'costo/gasto (5xxx)';
  return 'otro';
}

(async () => {
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  if (sid !== PROD) { console.error(`⛔ no es prod (${sid})`); process.exit(1); }
  const svc = new ContpaqiArmadoService(knex, new ContpaqiTxtSinkAdapter());
  svc.log = { log() {}, warn() {}, error() {} };

  const tabla = new Map();   // rubro → destino → { polizas, importe }
  const meter = (r, d, imp) => { if (!tabla.has(r)) tabla.set(r, new Map()); const t = tabla.get(r); const x = t.get(d) ?? { polizas: 0, importe: 0 }; x.polizas += 1; x.importe += imp; t.set(d, x); };
  const detalle = [];
  let totalPol = 0, totalImp = 0;
  for (const mes of meses(DESDE, HASTA)) {
    const { egresos, estados, lotes } = await svc.conTenant(async () => {
      const est = new Map();
      const eg = await svc.leerEgresos(mes);
      const r = await svc.construirLotes(mes, est);
      return { egresos: eg, estados: est, lotes: r.lotes };
    });
    // Movimientos del banco por (cuenta ContPAQi, importe) — incluso los «fuera de banco» no tienen cuenta: no casan.
    const porBanco = new Map();
    for (const e of egresos) { if (!e.cuenta_banco) continue; const k = `${e.cuenta_banco}|${cent(e.amount_out)}`; if (!porBanco.has(k)) porBanco.set(k, []); porBanco.get(k).push(e); }
    const usados = new Set();
    const lineas = await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return trx('analytics.gl_poliza_lines as l')
        .join('analytics.gl_polizas as p', function on() { this.on('p.tenant_id', 'l.tenant_id').andOn('p.source', 'l.source').andOn('p.ejercicio', 'l.ejercicio').andOn('p.periodo', 'l.periodo').andOn('p.tipo_pol', 'l.tipo_pol').andOn('p.folio', 'l.folio'); })
        .where('l.source', 'contpaqi').where('l.tipo_pol', '2').where('p.anio_mes', mes)
        .select('p.folio', 'p.concepto', knex.raw(`to_char(p.fecha,'YYYY-MM-DD') f`), 'l.cuenta', 'l.cargo_abono', 'l.importe', 'l.cfdi_uuid');
    });
    const pols = new Map();
    for (const l of lineas) {
      const p = pols.get(l.folio) ?? { folio: l.folio, concepto: l.concepto, f: l.f, bancos: [], cargos: [], cfdi: false };
      if (l.cargo_abono === 'A' && /^102/.test(l.cuenta)) p.bancos.push({ cuenta: l.cuenta, importe: Number(l.importe) });
      if (l.cargo_abono === 'C') p.cargos.push({ cuenta: l.cuenta, importe: Number(l.importe) });
      if (l.cfdi_uuid) p.cfdi = true;
      pols.set(l.folio, p);
    }
    for (const p of pols.values()) {
      const imp = p.bancos.reduce((a, b) => a + b.importe, 0) || p.cargos.reduce((a, b) => a + b.importe, 0);
      totalPol += 1; totalImp += imp;
      const r = rubro(p.cargos) + (p.cfdi ? ' · con CFDI' : ' · sin CFDI');
      if (!p.bancos.length) { meter(r, 'sin renglón de banco', imp); continue; }
      // Cada renglón de banco → su movimiento; la póliza toma el «peor» destino de sus renglones.
      const destinos = [];
      for (const b of p.bancos) {
        const c = (porBanco.get(`${b.cuenta}|${cent(b.importe)}`) ?? []).filter((e) => !usados.has(e.id) && Math.abs(dias(e.fecha, p.f)) <= 3)
          .sort((x, y) => Math.abs(dias(x.fecha, p.f)) - Math.abs(dias(y.fecha, p.f)));
        if (!c.length) { destinos.push('sin movimiento de banco que case'); continue; }
        usados.add(c[0].id);
        const st = estados.get(String(c[0].id));
        destinos.push(!st ? 'sin estado' : st.motivo === null ? 'ENTRA al archivo' : st.motivo);
      }
      const orden = ['sin movimiento de banco que case', 'sin_categoria', 'sin_regla', 'sin_medir', 'sin_centro_costo', 'no_aplica', 'pago_tarjeta', 'pago_a_confirmar', 'pago_no_cuadra', 'pago_sin_resolver'];
      const d = destinos.length > 1 && new Set(destinos).size > 1 ? (orden.find((o) => destinos.includes(o)) ?? destinos[0]) : destinos[0];
      meter(r, d, imp);
      detalle.push({ mes, folio: p.folio, fecha: p.f, concepto: p.concepto, rubro: r, destino: d, importe: Math.round(imp * 100) / 100, bancos: p.bancos.length });
    }
    console.log(`${mes}: ${pols.size} pólizas de egreso · ${lotes.filter((l) => l.asiento && l.resumen.incluidas > 0).length} armadas por el puente`);
  }
  console.log(`\n[CP.8.83] el universo · ${DESDE} → ${HASTA} · ${totalPol} pólizas de egreso de la contadora · $${(totalImp / 1e6).toFixed(1)} M`);
  const fila = (a, b, c, d) => console.log(`  ${a.padEnd(36)} ${b.padEnd(34)} ${String(c).padStart(6)} ${d.padStart(10)}`);
  fila('rubro', 'qué hace el puente', 'pól.', '$ M');
  for (const [r, t] of [...tabla.entries()].sort((a, b) => [...b[1].values()].reduce((s, x) => s + x.polizas, 0) - [...a[1].values()].reduce((s, x) => s + x.polizas, 0))) {
    for (const [d, x] of [...t.entries()].sort((a, b) => b[1].polizas - a[1].polizas)) fila(r, d, x.polizas, (x.importe / 1e6).toFixed(2));
  }
  const entra = detalle.filter((x) => x.destino === 'ENTRA al archivo').length;
  console.log(`\n  pólizas que el puente cubre (ENTRA): ${entra} de ${totalPol} (${((100 * entra) / totalPol).toFixed(1)} %)`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ desde: DESDE, hasta: HASTA, detalle }, null, 1));
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.stack); process.exit(1); });
