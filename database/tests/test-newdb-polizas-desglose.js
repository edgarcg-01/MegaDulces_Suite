/* eslint-disable no-console */
/**
 * `[LC.21]` — Candado del desglose del Auditor de pólizas (/contabilidad/polizas). Sólo lectura.
 *
 *   1. ⛔ El auditor de TIPO de póliza mide (`catalogAudit` = measured). Hasta el 2026-10-22 tronaba
 *      SIEMPRE: su SQL traía un `'?'` literal que knex tomaba como parámetro, y la pantalla, que se
 *      tragaba el error, pintaba «Sin incongruencias vivas» en verde con 3 vivas en prod.
 *      Prueba negativa del MECANISMO: un `'?'` sin escapar truena; escapado, no.
 *   2. ⭐ Cada fila del catálogo se desglosa en SUS documentos: renglones = «Docs», importe = «Importe».
 *   3. ⛔ La tarjeta «ContPAQi / Kepler» ya no sale `N / 0`: los conteos por fuente no se filtran.
 *   4. ⭐ Cada tarjeta = lo que lista su filtro: «Pólizas» = total de la lista sin filtros,
 *      «No cuadran» = total de la lista con `only_descuadre`.
 *
 * Contra prod (los datos de Kepler y ContPAQi sólo existen ahí). En otro destino: NO MEDIDO.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true, experimentalDecorators: true,
    emitDecoratorMetadata: true, moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
const ALIAS = {};
for (const m of fs.readFileSync(path.join(ROOT, 'tsconfig.base.json'), 'utf8')
  .matchAll(/"(@megadulces\/[^"]+)"\s*:\s*\[\s*"([^"]+)"/g)) ALIAS[m[1]] = path.join(ROOT, m[2]);
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(p, ...resto) { return ALIAS[p] ? ALIAS[p] : resolveOriginal.call(this, p, ...resto); };
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const knexLib = require('knex');
const { classify } = require('./_lib/assert-safe-target');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'polizas');
let ok = 0; let fail = 0; let nm = 0;
const check = (c, l) => { if (c) { ok += 1; console.log(`  ✓ ${l}`); } else { fail += 1; console.log(`  ✗ ${l}`); } };
const noMedido = (l) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${l}`); };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.21 desglose de pólizas: ${ok} ✓ / ${fail} ✗${nm ? ` · ${nm} NO MEDIDO` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url || classify(url).kind !== 'prod') { noMedido('destino no es prod: Kepler y ContPAQi reales sólo existen ahí'); return fin(); }
  const pool = knexLib({ client: 'pg', connection: url,
    pool: { min: 0, max: 3, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  try {
    const tk = { run: async (a, b) => pool.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return (typeof a === 'function' ? a : b)(trx);
    }) };
    const ctx = { requireTenantId: () => MEGA, get: () => ({ tenantId: MEGA, userId: null }) };
    const { PolizaTypeAuditService } = require(path.join(SRC, 'poliza-type-audit.service.ts'));
    const { PolizasService } = require(path.join(SRC, 'polizas.service.ts'));
    const tipos = new PolizaTypeAuditService(tk, ctx); tipos.logger = { log() {}, warn() {}, error() {}, debug() {} };
    const pol = new PolizasService(tk, ctx); pol.logger = tipos.logger;

    console.log('\n[1] El auditor de tipo de póliza mide');
    // Como en el defecto: knex sólo cuenta los ? cuando hay parámetros, y ahí cuenta también el literal.
    let e1 = null; try { await pool.raw(`SELECT '?' AS x, ?::int AS y`, [1]); } catch (e) { e1 = e.message; }
    let e2 = null; try { await pool.raw(`SELECT '\\?' AS x, ?::int AS y`, [1]); } catch (e) { e2 = e.message; }
    check(!!e1 && !e2, `⛔ mecanismo: un '?' literal sin escapar truena en knex («${String(e1).slice(0, 40)}»); escapado, no`);
    let cat = null; let err = null;
    try { cat = await tipos.catalogAudit(); } catch (e) { err = e.message; }
    check(cat && cat.state === 'measured', `catalogAudit mide (${cat ? cat.state : `truena: ${err}`})`);
    if (!cat) return;

    console.log('\n[2] Cada fila del catálogo se desglosa en sus documentos');
    const vivos = cat.data.incongruentes.filter((i) => i.docs > 0);
    if (!vivos.length) noMedido('no hay doctypes incongruentes en uso este año');
    for (const v of vivos.slice(0, 5)) {
      const d = await tipos.documentosDoctype(v.doc);
      check(d.renglones === v.docs && d.importe_renglones === v.importe && d.documentos <= d.renglones && d.filas.length === Math.min(d.documentos, d.page_size),
        `${v.doc}: renglones ${d.renglones} = Docs ${v.docs} · importe ${d.importe_renglones} = ${v.importe} · ${d.documentos} documentos distintos, ${d.filas.length} en la página`);
    }
    let eDoc = null; try { await tipos.documentosDoctype('X-A-20'); } catch (e) { eDoc = e.message; }
    check(/doctype inválido/.test(String(eDoc)), '⛔ un doctype mal formado se rechaza antes de ir al SQL');

    console.log('\n[3] «ContPAQi / Kepler» con una fuente elegida');
    const sC = await pol.summary('contpaqi');
    const sK = await pol.summary('kepler');
    check(sC.kepler === sK.kepler && sC.contpaqi === sK.contpaqi && sC.kepler > 0 && sC.contpaqi > 0,
      `los conteos por fuente no dependen de la elegida: ${sC.contpaqi} / ${sC.kepler} (antes, con ContPAQi elegido: ${sC.contpaqi} / 0)`);

    console.log('\n[4] Cada tarjeta = lo que lista su filtro');
    for (const src of ['contpaqi', 'kepler']) {
      const s = await pol.summary(src);
      const todas = await pol.list({ source: src, page: 1, page_size: 10 });
      const desc = await pol.list({ source: src, only_descuadre: true, page: 1, page_size: 10 });
      check(todas.total === s.total && desc.total === s.descuadradas,
        `${src}: «Pólizas» ${s.total} = lista ${todas.total} · «No cuadran» ${s.descuadradas} = lista ${desc.total}`);
    }
  } finally {
    await pool.destroy();
  }
  return fin();
})().catch((e) => { console.log(`  ✗ excepción: ${e && e.message}`); fail += 1; fin(); });
