#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.84]` — **Los pagos a proveedor que el puente no arma solo: ¿por qué, contra lo que hizo la contadora?**
 *
 * `[CP.8.83]` midió que 461 pagos quedan «a confirmar» y 281 «no cuadran» ($188 M, ene–sep 2026). Su póliza en
 * ContPAQi lleva el UUID de cada factura y nota que pagó. Este script pone lado a lado, pago por pago:
 *
 *   lo que ella pagó (UUID de facturas y notas, y CUÁNTO de cada una)  ←→  lo que el puente propone
 *   (`pagosPorConfirmar`: proveedor, facturas candidatas en la ventana, sugerencia)
 *
 * y clasifica la causa:
 *   · `sugerencia_correcta`   — el puente ya proponía exactamente sus facturas: sólo falta confiar en la sugerencia.
 *   · `candidatas_contienen`  — sus facturas están entre las candidatas pero la sugerencia no las eligió.
 *   · `parcial`               — ella pagó una fracción de alguna factura (REP con parcialidad).
 *   · `con_notas`             — ella aplicó notas.
 *   · `fuera_de_ventana`      — alguna factura suya no está entre las candidatas (fecha, ya «pagada» antes, …).
 *   · `cfdi_ausente`          — algún UUID suyo no está en `fiscal.cfdis`.
 *   · `otro_proveedor`        — el puente propone otro RFC.
 *   · `sin_proveedor`         — el puente no sabe de quién es.
 *   · `sin_poliza`            — no hay póliza real con esa pata de banco (no se puede calificar).
 *
 *   node database/scripts/pagos-sin-armar-contpaqi.js --desde=2026-01 --hasta=2026-09 [--json=salida.json]
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
const mismo = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

(async () => {
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  if (sid !== PROD) { console.error(`⛔ no es prod (${sid})`); process.exit(1); }
  const svc = new ContpaqiArmadoService(knex, new ContpaqiTxtSinkAdapter());
  svc.log = { log() {}, warn() {}, error() {} };
  const enTenant = (fn) => knex.transaction(async (trx) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]); return fn(trx); });

  const causas = {}; const detalle = [];
  const contar = (c, imp) => { causas[c] = causas[c] ?? { pagos: 0, importe: 0 }; causas[c].pagos += 1; causas[c].importe += imp; };
  for (const mes of meses(DESDE, HASTA)) {
    const pagos = (await svc.pagosPorConfirmar(mes)).filter((p) => !p.confirmacion);
    // Las pólizas reales del mes (±3 días a la orilla), con sus UUID por renglón.
    const desde = new Date(Date.parse(`${mes}-01T12:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10);
    const hasta = new Date(Date.parse(`${mes}-01T12:00:00Z`) + 34 * 86400000).toISOString().slice(0, 10);
    const lineas = await enTenant((trx) => trx('analytics.gl_poliza_lines as l')
      .join('analytics.gl_polizas as p', function on() { this.on('p.tenant_id', 'l.tenant_id').andOn('p.source', 'l.source').andOn('p.ejercicio', 'l.ejercicio').andOn('p.periodo', 'l.periodo').andOn('p.tipo_pol', 'l.tipo_pol').andOn('p.folio', 'l.folio'); })
      .where('l.source', 'contpaqi').where('l.tipo_pol', '2').where('p.fecha', '>=', desde).where('p.fecha', '<', hasta)
      .select('p.ejercicio', 'p.periodo', 'p.folio', knex.raw(`to_char(p.fecha,'YYYY-MM-DD') f`), 'l.cuenta', 'l.cargo_abono', 'l.importe', 'l.cfdi_uuid'));
    const pols = new Map();
    for (const l of lineas) {
      const k = `${l.ejercicio}|${l.periodo}|${l.folio}`;
      const p = pols.get(k) ?? { k, f: l.f, bancos: [], porUuid: new Map(), lineas: [] };
      p.lineas.push(l);
      if (l.cargo_abono === 'A' && /^102/.test(l.cuenta)) p.bancos.push({ cuenta: l.cuenta, importe: Number(l.importe) });
      if (l.cfdi_uuid) { const u = String(l.cfdi_uuid).toUpperCase(); const x = p.porUuid.get(u) ?? { cargo: 0, abono: 0 }; x[l.cargo_abono === 'C' ? 'cargo' : 'abono'] += Number(l.importe); p.porUuid.set(u, x); }
      pols.set(k, p);
    }
    const porBanco = new Map();
    for (const p of pols.values()) for (const b of p.bancos) { const kk = `${b.cuenta}|${cent(b.importe)}`; if (!porBanco.has(kk)) porBanco.set(kk, []); porBanco.get(kk).push(p); }
    const usadas = new Set();
    // Los UUID que ella usó y su tipo/total en fiscal.cfdis.
    const todos = [...new Set([...pols.values()].flatMap((p) => [...p.porUuid.keys()]))];
    const cfdis = new Map((await enTenant((trx) => trx('fiscal.cfdis').where({ rol: 'recibidas' }).whereRaw('upper(uuid) = ANY(?)', [todos])
      .select(knex.raw('upper(uuid) u'), 'tipo_comprobante as tc', 'emisor_rfc as rfc', knex.raw('total::float8 tot'))))
      .map((c) => [c.u, c]));

    for (const pg of pagos) {
      const c = (porBanco.get(`${pg.cuenta_banco}|${cent(pg.importe)}`) ?? []).filter((p) => !usadas.has(p.k) && Math.abs(dias(p.f, pg.fecha)) <= 3)
        .sort((a, b) => Math.abs(dias(a.f, pg.fecha)) - Math.abs(dias(b.f, pg.fecha)));
      const base = { mes, movimiento: pg.movimiento_id, fecha: pg.fecha, importe: pg.importe, concepto: pg.concepto, motivo: pg.motivo };
      if (!c.length) { contar('sin_poliza', pg.importe); detalle.push({ ...base, causa: 'sin_poliza' }); continue; }
      const real = c[0]; usadas.add(real.k);
      const uuids = [...real.porUuid.keys()];
      const ausentes = uuids.filter((u) => !cfdis.has(u));
      const facturas = uuids.filter((u) => cfdis.get(u)?.tc === 'I');
      const notas = uuids.filter((u) => cfdis.get(u)?.tc === 'E');
      const parcial = facturas.some((u) => { const x = real.porUuid.get(u); const t = cfdis.get(u).tot; return x.cargo + 0.05 < t; });
      const p = pg.propuesta;
      const candidatas = p ? p.facturas.map((f) => String(f.uuid).toUpperCase()) : [];
      const sugerencia = p ? p.sugerencia.map((u) => String(u).toUpperCase()) : [];
      const rfcElla = [...new Set(facturas.map((u) => cfdis.get(u).rfc))];
      let causa;
      if (!uuids.length) causa = 'sin_uuid_en_su_poliza';
      else if (ausentes.length) causa = 'cfdi_ausente';
      else if (!p) causa = 'sin_proveedor';
      else if (rfcElla.length && !rfcElla.includes(p.rfc)) causa = 'otro_proveedor';
      else if (facturas.length && mismo(sugerencia, facturas) && !notas.length) causa = 'sugerencia_correcta';
      else if (parcial) causa = 'parcial';
      else if (notas.length) causa = 'con_notas';
      else if (facturas.every((u) => candidatas.includes(u))) causa = 'candidatas_contienen';
      else causa = 'fuera_de_ventana';
      contar(causa, pg.importe);
      detalle.push({ ...base, causa, poliza: real.k, facturas: facturas.length, notas: notas.length, ausentes: ausentes.length,
        en_candidatas: facturas.filter((u) => candidatas.includes(u)).length, candidatas: candidatas.length, sugerencia: sugerencia.length, rfc_puente: p?.rfc ?? null, rfc_ella: rfcElla,
        // Para simular otras búsquedas contra lo que ella hizo: sus UUID y las candidatas con su total.
        ella: { facturas, notas }, sugerida: sugerencia, origen: p?.origen ?? null,
        cand_facturas: p ? p.facturas.map((f) => ({ u: String(f.uuid).toUpperCase(), t: f.total, f: f.fecha, pagada_antes: f.pagada_antes })) : [],
        cand_notas: p ? p.notas.map((f) => ({ u: String(f.uuid).toUpperCase(), t: f.total, f: f.fecha })) : [] });
    }
    console.log(`${mes}: ${pagos.length} pagos sin armar`);
  }
  const total = Object.values(causas).reduce((a, x) => a + x.pagos, 0);
  console.log(`\n[CP.8.84] pagos a proveedor que el puente no arma solo · ${DESDE} → ${HASTA} · ${total} pagos`);
  for (const [k, v] of Object.entries(causas).sort((a, b) => b[1].pagos - a[1].pagos)) console.log(`  ${k.padEnd(24)} ${String(v.pagos).padStart(5)}  $${(v.importe / 1e6).toFixed(1).padStart(6)} M`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ desde: DESDE, hasta: HASTA, causas, detalle }, null, 1));
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.stack); process.exit(1); });
