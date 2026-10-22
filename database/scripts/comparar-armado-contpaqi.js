#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.81]` — **¿Las pólizas que arma el puente son las que capturó contabilidad?** Prueba A/B sobre meses cerrados.
 *
 * Arma cada mes con **el mismo camino que el archivo** (`ContpaqiArmadoService.construirLotes`, el que usa
 * `generarArchivoMes`) y compara cada póliza armada contra la que la contadora capturó en ContPAQi
 * (`analytics.gl_poliza_lines`, tipo 2 = egresos, `source = 'contpaqi'`). La póliza real SÓLO califica.
 *
 * ── Cómo se empareja ────────────────────────────────────────────────────────────────────────
 * Por la pata de banco: la póliza real que abona **la misma cuenta de banco, el mismo importe, el mismo día**
 * (si no, ±3 días). Si hay más de una candidata, desempata la cuenta del proveedor; si sigue habiendo dos, es
 * ambigua y NO se califica. Una póliza real se usa una sola vez.
 *
 * ⛔ Un cruce por importe exige control: el PLACEBO busca lo mismo pero en OTRA cuenta de banco. Si el placebo
 *    empareja mucho, el cruce no distingue nada.
 *
 * ── Cómo se califica ────────────────────────────────────────────────────────────────────────
 *  · `igual`      — Σ por (cuenta, cargo/abono) idéntica a ±$0.02 en todas las cuentas.
 *  · `difiere`    — alguna cuenta falta, sobra o trae otro importe. Se dice cuál, con el patrón:
 *                   frontera 2120↔5010/5020, IVA/IEPS, redondeo, nota, cuenta de proveedor distinta.
 *  · `agrupada`   — la póliza real junta este pago con otros movimientos de banco: no se califica renglón a
 *                   renglón (la nuestra es un pago; la de ella, varios).
 *  · `sin_par`    — no hay póliza real con esa pata de banco (no se capturó, o con otro importe/fecha).
 *  · `ambigua`    — dos o más candidatas que no se pueden distinguir.
 * Y aparte: los UUID que viajan en el `AD` contra los que ella asoció a la póliza.
 *
 *   node database/scripts/comparar-armado-contpaqi.js --desde=2026-01 --hasta=2026-09 [--detalle=2026-08] [--json=salida.json]
 *
 * Sólo lectura: la sesión se abre con `default_transaction_read_only = on` y se verifica `system_identifier`.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
const ALIAS = { '@megadulces/contracts': path.join(ROOT, 'libs/contracts/src/index.ts') };
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(p, ...resto) {
  return ALIAS[p] ? ALIAS[p] : resolveOriginal.call(this, p, ...resto);
};
const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'contpaqi');
const PAGO = require(path.join(SRC, 'pago-proveedor.ts'));
const { AsientoRechazado } = require(path.join(SRC, 'poliza-egreso.ts'));
const { ContpaqiArmadoService } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));

/**
 * ── Experimentos (`--experimento=a,b`) ─────────────────────────────────────────────────────
 * Para medir una hipótesis ANTES de cambiar el armador: alteran la ENTRADA de `armarPagoProveedorCompleto` (el
 * armador real, envuelto) y se compara cuántas pólizas iguales gana o pierde. No tocan el código de producto.
 *   base_iva        la base al 16 % sale del IVA (`iva / 0.16`), no de `subtotal_iva_16` del CFDI
 *   solo_provision  2120 sólo si la factura está en la provisión de su mes (sin la regla de 20 mil + mes anterior)
 *   tdc             un pago cuyo concepto dice TDC (tarjeta de crédito) no se arma como pago a proveedor
 *   nota_historial  descuento o devolución según lo que ella usó ANTES con ese proveedor (si no hay, el CFDI)
 */
const EXPERIMENTOS = new Set(String((process.argv.find((a) => a.startsWith('--experimento=')) ?? '').split('=')[1] ?? '')
  .split(',').filter(Boolean));
let HISTORIAL_NOTAS = null;   // sufijo → [{ mes, dev }], se carga si hace falta
function envolverArmador() {
  if (!EXPERIMENTOS.size) return;
  const original = PAGO.armarPagoProveedorCompleto;
  PAGO.armarPagoProveedorCompleto = (e) => {
    let x = { ...e, facturas: e.facturas.map((f) => ({ ...f })), notas: e.notas.map((n) => ({ ...n })) };
    if (EXPERIMENTOS.has('tdc') && /\bTDC\b/i.test(x.concepto)) throw new AsientoRechazado('tarjeta', 'pago de tarjeta de crédito');
    if (EXPERIMENTOS.has('base_iva')) { for (const c of [...x.facturas, ...x.notas]) c.base16 = null; }
    if (EXPERIMENTOS.has('solo_provision')) {
      // Con la fecha de la factura en el mes del pago, la regla de «mes anterior» nunca dispara: queda la provisión.
      for (const f of x.facturas) f.fecha = x.fecha;
    }
    if (EXPERIMENTOS.has('nota_historial') && HISTORIAL_NOTAS) {
      const previas = (HISTORIAL_NOTAS.get(x.sufijo) ?? []).filter((h) => h.mes < x.fecha.slice(0, 7));
      if (previas.length) {
        const dev = previas.filter((h) => h.dev).length;
        for (const n of x.notas) n.tipoRelacion = dev * 2 > previas.length ? '03' : '01';
      }
    }
    return original(x);
  };
}
envolverArmador();

const PROD = '7688376744939610156';
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const arg = (n, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const DESDE = arg('desde', '2026-01');
const HASTA = arg('hasta', DESDE);
const DETALLE = arg('detalle', null);
const JSON_OUT = arg('json', null);
const TOL = 2; // centavos

function meses(desde, hasta) {
  const out = [];
  let [y, m] = desde.split('-').map(Number);
  const [yh, mh] = hasta.split('-').map(Number);
  while (y < yh || (y === yh && m <= mh)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
const cent = (n) => Math.round(Number(n) * 100);
const esBanco = (c) => /^102/.test(c);
const diasEntre = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
const sumarDias = (f, d) => new Date(Date.parse(`${f}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

/** Σ por (cuenta, C/A) en centavos. */
function huella(renglones) {
  const m = new Map();
  for (const r of renglones) {
    const k = `${r.cuenta}|${r.abono ? 'A' : 'C'}`;
    m.set(k, (m.get(k) ?? 0) + cent(r.importe));
  }
  return m;
}

/** Las diferencias, cuenta por cuenta, y el patrón que las explica. */
function diferencias(nuestra, real) {
  const a = huella(nuestra), b = huella(real);
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0, y = b.get(k) ?? 0;
    if (Math.abs(x - y) > TOL) out.push({ cuenta: k, nuestra: x / 100, real: y / 100 });
  }
  return out;
}

/**
 * Qué explica la diferencia. Puede ser más de una cosa a la vez; se devuelve la PRIMERA de esta lista, que va de
 * lo más específico a lo más general, y las demás como `tambien`.
 */
function patron(difs) {
  const c = (d) => d.cuenta.split('|')[0];
  const soloNuestra = difs.filter((d) => d.nuestra && !d.real).map(c);
  const soloReal = difs.filter((d) => d.real && !d.nuestra).map(c);
  const hay = (lista, re) => lista.some((x) => re.test(x));
  const tags = [];
  if (difs.every((d) => Math.abs(d.nuestra - d.real) < 1)) tags.push('redondeo');
  if (hay(soloReal, /^2140/)) tags.push('tarjeta_de_credito');          // ella lo asienta como pago de tarjeta
  if (hay(soloReal, /^1050/)) tags.push('anticipo');                    // ella lo asienta como anticipo
  if ((hay(soloNuestra, /^5050/) && hay(soloReal, /^5060/)) || (hay(soloNuestra, /^5070/) && hay(soloReal, /^5080/))
    || (hay(soloNuestra, /^5060/) && hay(soloReal, /^5050/)) || (hay(soloNuestra, /^5080/) && hay(soloReal, /^5070/))) tags.push('nota_descuento_vs_devolucion');
  const r2120 = difs.some((d) => /^2120/.test(c(d))), r50 = difs.some((d) => /^50[12]0/.test(c(d)));
  if (r2120 && r50) tags.push('frontera_2120');                         // provisión (2120) contra compra directa (5010/5020)
  if (!r2120 && hay(difs.map(c), /^5010/) && hay(difs.map(c), /^5020/)) tags.push('tasa_5010_5020');
  if (hay(difs.map(c), /^(1060|1470)/)) tags.push('impuesto');
  if (!tags.length) tags.push('otro');
  return tags;
}

(async () => {
  const knex = require('knex')({
    client: 'pg', connection: process.env.DATABASE_URL_NEW,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  if (sid !== PROD) { console.error(`⛔ no es prod (${sid})`); process.exit(1); }
  const svc = new ContpaqiArmadoService(knex, new ContpaqiTxtSinkAdapter());
  svc.log = { log() {}, warn() {}, error() {} };
  if (EXPERIMENTOS.has('nota_historial')) {
    // Lo que ella abonó a descuento (5050/5070) o devolución (5060/5080) por proveedor y mes, en egresos.
    const filas = await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return trx('analytics.gl_poliza_lines').where({ source: 'contpaqi', tipo_pol: '2', cargo_abono: 'A' })
        .whereRaw(`cuenta ~ '^50[5-8]0'`).select('anio_mes', 'cuenta');
    });
    HISTORIAL_NOTAS = new Map();
    for (const f of filas) {
      const suf = f.cuenta.slice(4);
      if (!HISTORIAL_NOTAS.has(suf)) HISTORIAL_NOTAS.set(suf, []);
      HISTORIAL_NOTAS.get(suf).push({ mes: f.anio_mes, dev: /^50[68]0/.test(f.cuenta) });
    }
  }
  if (EXPERIMENTOS.size) console.log(`experimentos: ${[...EXPERIMENTOS].join(', ')}`);

  const total = { armadas: 0, igual: 0, difiere: 0, agrupada: 0, sin_par: 0, ambigua: 0, placebo: 0, uuid_igual: 0, uuid_comparables: 0 };
  const patrones = {};
  const porMes = [];
  const detalle = [];

  for (const mes of meses(DESDE, HASTA)) {
    const t0 = Date.now();
    const { lotes, estados } = await svc.conTenant(async () => {
      const est = new Map();
      const r = await svc.construirLotes(mes, est);
      return { lotes: r.lotes, estados: est };
    });
    const armadas = lotes.filter((l) => l.asiento && l.resumen.incluidas > 0);

    // Las pólizas reales de egreso del mes, con ±3 días a las orillas.
    const desde = sumarDias(`${mes}-01`, -3);
    const hasta = sumarDias(sumarDias(`${mes}-01`, 32).slice(0, 7) + '-01', 3);
    const lineas = await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return trx('analytics.gl_poliza_lines as l')
        .join('analytics.gl_polizas as p', function on() {
          this.on('p.tenant_id', 'l.tenant_id').andOn('p.source', 'l.source').andOn('p.ejercicio', 'l.ejercicio')
            .andOn('p.periodo', 'l.periodo').andOn('p.tipo_pol', 'l.tipo_pol').andOn('p.folio', 'l.folio');
        })
        .where('l.source', 'contpaqi').where('l.tipo_pol', '2')
        .where('p.fecha', '>=', desde).where('p.fecha', '<', hasta)
        .select('p.ejercicio', 'p.periodo', 'p.folio', knex.raw(`to_char(p.fecha, 'YYYY-MM-DD') as fecha`),
          'l.num_movto', 'l.cuenta', 'l.cargo_abono', 'l.importe', 'l.cfdi_uuid');
    });
    const reales = new Map();
    for (const l of lineas) {
      const k = `${l.ejercicio}|${l.periodo}|${l.folio}`;
      if (!reales.has(k)) reales.set(k, { k, fecha: l.fecha, renglones: [], uuids: new Set() });
      const p = reales.get(k);
      if (!(l.cuenta === null && l.importe === null)) p.renglones.push({ cuenta: l.cuenta, abono: l.cargo_abono === 'A', importe: Number(l.importe) });
      if (l.cfdi_uuid) p.uuids.add(String(l.cfdi_uuid).toUpperCase());
    }
    // Índice por la pata de banco: (cuenta, importe en centavos) → pólizas.
    const porBanco = new Map();
    for (const p of reales.values()) {
      for (const r of p.renglones.filter((x) => x.abono && esBanco(x.cuenta))) {
        const k = `${r.cuenta}|${cent(r.importe)}`;
        if (!porBanco.has(k)) porBanco.set(k, []);
        porBanco.get(k).push(p);
      }
    }
    const usadas = new Set();
    const cuentasBanco = [...new Set(lineas.filter((l) => esBanco(l.cuenta)).map((l) => l.cuenta))];

    const m = { mes, armadas: armadas.length, igual: 0, difiere: 0, agrupada: 0, sin_par: 0, ambigua: 0, placebo: 0 };
    for (const l of armadas) {
      const a = l.asiento;
      const bancos = a.movimientos.filter((x) => x.abono && esBanco(x.cuenta));
      if (bancos.length !== 1) { m.agrupada += 1; continue; }   // un lote de varios movimientos: hoy no se arma ninguno
      const b = bancos[0];
      const candidatas = (porBanco.get(`${b.cuenta}|${cent(b.importe)}`) ?? []).filter((p) => !usadas.has(p.k));
      const cerca = (d) => candidatas.filter((p) => Math.abs(diasEntre(p.fecha, a.fecha)) <= d);
      let c = cerca(0);
      if (!c.length) c = cerca(3);
      if (c.length > 1) {
        const prov = a.movimientos.find((x) => !x.abono && /^(2120|5010|5020)/.test(x.cuenta));
        const conProv = prov ? c.filter((p) => p.renglones.some((r) => !r.abono && r.cuenta === prov.cuenta)) : [];
        if (conProv.length === 1) c = conProv;
      }
      // Placebo: la misma búsqueda en OTRA cuenta de banco.
      for (const otra of cuentasBanco) {
        if (otra === b.cuenta) continue;
        if ((porBanco.get(`${otra}|${cent(b.importe)}`) ?? []).some((p) => Math.abs(diasEntre(p.fecha, a.fecha)) <= 3)) { m.placebo += 1; break; }
      }
      const fila = { mes, clave: l.clave, fecha: a.fecha, banco: b.cuenta, importe: b.importe, concepto: a.concepto };
      if (!c.length) { m.sin_par += 1; detalle.push({ ...fila, resultado: 'sin_par' }); continue; }
      if (c.length > 1) { m.ambigua += 1; detalle.push({ ...fila, resultado: 'ambigua', candidatas: c.map((p) => p.k) }); continue; }
      const real = c[0];
      usadas.add(real.k);
      const bancosReales = real.renglones.filter((x) => x.abono && esBanco(x.cuenta));
      if (bancosReales.length > 1) { m.agrupada += 1; detalle.push({ ...fila, resultado: 'agrupada', real: real.k, bancos_reales: bancosReales.length }); continue; }
      const difs = diferencias(a.movimientos, real.renglones);
      const nuestros = new Set((l.uuids ?? []).map((u) => String(u).toUpperCase()));
      const uuidIgual = nuestros.size > 0 && real.uuids.size > 0
        ? (nuestros.size === real.uuids.size && [...nuestros].every((u) => real.uuids.has(u))) : null;
      if (uuidIgual !== null) { total.uuid_comparables += 1; if (uuidIgual) total.uuid_igual += 1; }
      if (!difs.length) { m.igual += 1; detalle.push({ ...fila, resultado: 'igual', real: real.k, uuid_igual: uuidIgual }); continue; }
      m.difiere += 1;
      const tags = patron(difs);
      const p = tags[0];
      patrones[p] = (patrones[p] ?? 0) + 1;
      detalle.push({ ...fila, resultado: 'difiere', patron: tags.join('+'), real: real.k, uuid_igual: uuidIgual, diferencias: difs,
        // Para investigar la causa: qué comprobantes usó cada lado y los renglones completos.
        uuids: [...nuestros], uuids_real: [...real.uuids],
        renglones: a.movimientos.map((x) => ({ cuenta: x.cuenta, abono: x.abono, importe: x.importe })),
        renglones_real: real.renglones });
    }
    for (const k of ['armadas', 'igual', 'difiere', 'agrupada', 'sin_par', 'ambigua', 'placebo']) total[k] += m[k];
    // Lo que el puente NO armó del mes (el techo), por motivo, para no leer la tasa sin su universo.
    const noArmados = {};
    for (const [, e] of estados) if (e.motivo && e.motivo.startsWith('pago_')) noArmados[e.motivo] = (noArmados[e.motivo] ?? 0) + 1;
    m.pagos_no_armados = noArmados;
    m.reales_egreso = reales.size;
    m.ms = Date.now() - t0;
    porMes.push(m);
    console.log(`${mes}: armadas ${m.armadas} · iguales ${m.igual} · difieren ${m.difiere} · agrupadas ${m.agrupada}`
      + ` · sin par ${m.sin_par} · ambiguas ${m.ambigua} · placebo ${m.placebo}`
      + ` · pagos no armados ${JSON.stringify(noArmados)} · ${m.reales_egreso} pólizas reales · ${m.ms} ms`);
  }

  const calificadas = total.igual + total.difiere;
  console.log(`\n[CP.8.81] armado del puente vs ContPAQi · ${DESDE} → ${HASTA} · system_identifier ${sid}`);
  console.log(`  pólizas armadas ${total.armadas} · calificadas ${calificadas} · IGUALES ${total.igual}`
    + ` (${calificadas ? ((100 * total.igual) / calificadas).toFixed(1) : '—'} %) · difieren ${total.difiere}`);
  console.log(`  sin calificar: agrupadas ${total.agrupada} · sin par ${total.sin_par} · ambiguas ${total.ambigua}`);
  console.log(`  placebo (mismo importe ±3 días en OTRA cuenta de banco): ${total.placebo} de ${total.armadas}`);
  console.log(`  UUID del AD iguales a los que ella asoció: ${total.uuid_igual} de ${total.uuid_comparables} comparables`);
  console.log('  diferencias por patrón:', JSON.stringify(patrones));
  if (DETALLE) {
    console.log(`\n── detalle ${DETALLE} (lo que no salió igual) ──`);
    for (const d of detalle.filter((x) => x.mes === DETALLE && x.resultado !== 'igual')) {
      console.log(`  ${d.resultado.padEnd(9)} ${d.fecha} ${d.banco} $${d.importe} ${String(d.concepto).slice(0, 50)}`
        + (d.patron ? ` · ${d.patron}` : '') + (d.real ? ` · real ${d.real}` : ''));
      for (const x of d.diferencias ?? []) console.log(`              ${x.cuenta.padEnd(13)} nuestra ${x.nuestra}  real ${x.real}`);
    }
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ desde: DESDE, hasta: HASTA, total, patrones, porMes, detalle }, null, 1));
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.stack); process.exit(1); });
