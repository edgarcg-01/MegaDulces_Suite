/* eslint-disable no-console */
/**
 * `[CP.8.80]` — **Candado de «categorizar un egreso desde el puente, y recordarlo por beneficiario».**
 *
 * ⛔ Regla 13: un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra una base real, con el
 * payload de la pantalla (`{ categoria, beneficiario? }`). Dos modos según el destino:
 *
 *   destino LOCAL (job `pruebas-db` del CI) → **completo**: siembra con `DATABASE_URL_NEW` (postgres) egresos de
 *     un beneficiario escrito de varias formas, más los que la regla NO debe tocar, y lo ejerce con el pool de
 *     `DATABASE_URL_NEW_RUNTIME` (`app_runtime`: RLS forzado, sin tenant por default, igual que prod).
 *   destino PROD → **sólo lectura**: categorías y la vista previa sobre un egreso real sin categoría; la
 *     escritura se declara NO MEDIDA.
 *
 * Lo que exige el modo completo:
 *   1. las categorías son sólo de egreso (`flow` out/both);
 *   2. la vista previa cuenta los 3 que empiezan con el nombre, en palabra completa, y nada más;
 *   3. ⛔ rechazos SIN escribir nada: texto que no es del movimiento, un depósito, uno ya categorizado, una
 *      categoría de ingreso;
 *   4. categorizar con beneficiario: el movimiento queda `manual`, la regla nueva (prioridad ≥ 1000, con autor) y
 *      los otros 2 quedan `rule` — y ⛔ NO se tocan: el depósito, el «Candadoz», el `manual` vacío, el ya
 *      categorizado, ni el que trae el nombre a media frase;
 *   5. ⛔ el mismo texto hacia OTRA categoría → rechazado y el movimiento sigue vacío (la transacción se deshace);
 *   6. el mismo texto y la misma categoría → reusa la regla (no crea otra);
 *   7. ⛔ sin tenant, `app_runtime` no ve la regla (RLS).
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});

const knexLib = require('knex');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { classify, assertSafeTarget } = require('./_lib/assert-safe-target');

const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'contpaqi');
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const MES = '2031-03';
const CAT = 'cp880_candado';
const CAT_OTRA = 'cp880_otra';
const CAT_IN = 'cp880_ingreso';
const POR = 'candado-cp880';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log() {}, warn() {}, error() {}, debug() {} };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.80 categorizar desde el puente: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

function servicio(pool) {
  const { ContpaqiCategoriaService, CategorizacionRechazada } = require(path.join(SRC, 'contpaqi-categoria.service.ts'));
  const svc = new ContpaqiCategoriaService(pool);
  svc.log = silencio;
  return { svc, CategorizacionRechazada };
}

async function rechaza(fn, Clase) {
  try { await fn(); return null; } catch (e) { return e instanceof Clase ? e : new Error(`otro error: ${e && e.message}`); }
}

async function soloLectura(url) {
  console.log('\n[modo SÓLO LECTURA — destino prod]');
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  try {
    const { svc } = servicio(pool);
    const cats = await svc.categorias();
    const codes = new Set(cats.map((c) => c.code));
    check(codes.has('nomina') && codes.has('compra_mercancia'), `${cats.length} categorías de egreso, con nómina y compra de mercancía`);
    check(!codes.has('cobranza') && !codes.has('sin_clasificar'), 'sin categorías de ingreso ni «sin clasificar»');
    // Un egreso real sin categoría con nombre propio: el control es Oscar, medido en tres formas (2026-10-22).
    const m = (await pool.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return trx('finance.bank_movements').where({ tenant_id: MEGA }).whereNull('category_id').whereNull('deleted_at')
        .where('amount_out', '>', 0).whereNot('classified_by', 'manual').whereRaw(`upper(concept) LIKE 'OSCAR HERNANDEZ%'`)
        .first('id', 'concept');
    }));
    if (!m) { noMedido('ningún egreso de «Oscar Hernandez» sin categoría (¿ya se categorizó?)'); }
    else {
      const v = await svc.vistaPrevia(m.id, 'Oscar Hernandez');
      check(v.movimientos >= 1 && v.filas.some((f) => f.id === m.id), `vista previa «${v.texto}»: ${v.movimientos} egresos sin categoría ($${v.importe}), incluye «${m.concept}»`);
      check(v.filas.every((f) => /^OSCAR HERN[AÁ]NDEZ(?![A-Z0-9ÁÉÍÓÚÜÑ])/i.test(f.concepto.replace(/\s+/g, ' ').trim())), 'todas empiezan con el nombre, en palabra completa');
      check(v.filas.length <= 50 && v.movimientos >= v.filas.length, 'la muestra no pasa de 50 y el total se cuenta entero');
    }
    noMedido('categorizar: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[modo COMPLETO — destino local]');
  assertSafeTarget('test-newdb-contpaqi-categorizar', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-categorizar', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = {};
  try {
    console.log('\n[0] Sembrar (postgres: siembra, no prueba)');
    const [cta] = await admin('finance.bank_accounts').insert({
      tenant_id: MEGA, bank: 'CANDADO', account_label: 'CP880', kind: 'bank',
    }).returning('id');
    ids.cuenta = cta.id ?? cta;
    const [est] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: ids.cuenta, period: MES }).returning('id');
    const estado = est.id ?? est;
    const cat = async (code, flow) => {
      const [c] = await admin('finance.movement_categories').insert({ tenant_id: MEGA, code, name: `Candado ${code}`, flow, group_key: 'candado' }).returning('id');
      return c.id ?? c;
    };
    ids.cat = await cat(CAT, 'out');
    ids.catOtra = await cat(CAT_OTRA, 'out');
    ids.catIn = await cat(CAT_IN, 'in');
    let n = 0;
    const mov = async (tipo, codigo, concepto, fuera, extra = {}) => {
      n += 1;
      const [r] = await admin('finance.bank_movements').insert({
        tenant_id: MEGA, statement_id: estado, bank_account_id: ids.cuenta, movement_date: `${MES}-${String(n).padStart(2, '0')}`,
        client_uuid: `cp880-candado-${n}`, raw_type: tipo, raw_code: codigo, concept: concepto,
        amount_out: fuera, amount_in: fuera ? 0 : 50, classified_by: 'rule', ...extra,
      }).returning('id');
      return r.id ?? r;
    };
    ids.m1 = await mov('G', '613', 'Oscar Candado R', 100);
    ids.m2 = await mov('G', '613', 'Oscar Candado Rodriguez', 200);
    ids.m3 = await mov('G', '612', 'OSCAR CANDADO', 300);
    ids.dep = await mov('I', '102', 'Oscar Candado', 0);
    ids.casi = await mov('G', '613', 'Oscar Candadoz', 400);
    ids.manual = await mov('G', '613', 'Oscar Candado', 500, { classified_by: 'manual' });
    ids.yaTiene = await mov('G', '613', 'Oscar Candado X', 600, { category_id: ids.catOtra });
    ids.media = await mov('G', '613', 'PAGO A OSCAR CANDADO', 700);
    check(true, 'sembrado: 3 egresos del beneficiario + 5 que la regla no debe tocar');

    const { svc, CategorizacionRechazada } = servicio(runtime);
    const leer = async (id) => admin('finance.bank_movements as m').leftJoin('finance.movement_categories as c', 'c.id', 'm.category_id')
      .where('m.id', id).first('c.code', 'm.classified_by');
    const reglas = async () => admin('finance.bank_classify_rules').where({ tenant_id: MEGA }).where('note', 'like', `%${POR}%`);

    console.log('\n[1] Categorías: sólo de egreso');
    const cats = new Set((await svc.categorias()).map((c) => c.code));
    check(cats.has(CAT) && cats.has(CAT_OTRA) && !cats.has(CAT_IN), 'las de egreso sí, la de ingreso no');

    console.log('\n[2] Vista previa: los 3 que empiezan con el nombre, y nada más');
    const v = await svc.vistaPrevia(String(ids.m1), 'oscar candado');
    const vistos = new Set(v.filas.map((f) => f.id));
    check(v.movimientos === 3 && v.importe === 600, `3 egresos, $600 — dio ${v.movimientos}, $${v.importe}`);
    check([ids.m1, ids.m2, ids.m3].every((i) => vistos.has(String(i))), 'R, Rodriguez y el de mayúsculas con otro código');
    check(v.regla_existente === null, 'todavía no hay regla con ese texto');

    console.log('\n[3] ⛔ Rechazos que no escriben nada');
    let e = await rechaza(() => svc.categorizar(String(ids.m1), { categoria: CAT, beneficiario: 'Valentin Oyanguren' }, POR), CategorizacionRechazada);
    check(e instanceof CategorizacionRechazada, `texto ajeno al movimiento: «${String(e && e.message).slice(0, 60)}…»`);
    e = await rechaza(() => svc.categorizar(String(ids.dep), { categoria: CAT }, POR), CategorizacionRechazada);
    check(e instanceof CategorizacionRechazada, 'un depósito: rechazado');
    e = await rechaza(() => svc.categorizar(String(ids.yaTiene), { categoria: CAT }, POR), CategorizacionRechazada);
    check(e instanceof CategorizacionRechazada, 'uno que ya tiene categoría: rechazado');
    e = await rechaza(() => svc.categorizar(String(ids.m1), { categoria: CAT_IN }, POR), CategorizacionRechazada);
    check(e instanceof CategorizacionRechazada, 'una categoría de ingreso: rechazada');
    e = await rechaza(() => svc.categorizar(String(ids.m1), { categoria: CAT }, ''), CategorizacionRechazada);
    check(e instanceof CategorizacionRechazada, 'sin autor: rechazado');
    check((await leer(ids.m1)).code === null && (await reglas()).length === 0, 'tras los rechazos: el movimiento sigue vacío y no hay regla');

    console.log('\n[4] Categorizar recordando al beneficiario');
    const r = await svc.categorizar(String(ids.m1), { categoria: CAT, beneficiario: 'Oscar Candado' }, POR);
    check(r.aplicados === 2 && r.importe_aplicado === 500, `la regla tomó 2 más por $500 — dio ${r.aplicados}, $${r.importe_aplicado}`);
    check(!!r.regla && r.regla.nueva && r.regla.prioridad >= 1000, `regla nueva al final del catálogo (p${r.regla && r.regla.prioridad})`);
    const m1 = await leer(ids.m1);
    check(m1.code === CAT && m1.classified_by === 'manual', 'el movimiento: la categoría, decidida a mano');
    const [m2, m3] = [await leer(ids.m2), await leer(ids.m3)];
    check(m2.code === CAT && m2.classified_by === 'rule' && m3.code === CAT && m3.classified_by === 'rule', 'los otros dos: la categoría, por regla');
    const intactos = await Promise.all([ids.dep, ids.casi, ids.manual, ids.media].map(leer));
    check(intactos.every((x) => x.code === null), '⛔ intactos: el depósito, «Candadoz», el manual vacío y el nombre a media frase');
    check((await leer(ids.yaTiene)).code === CAT_OTRA, '⛔ el ya categorizado conserva su categoría');
    const rs = await reglas();
    check(rs.length === 1 && rs[0].category_code === CAT && rs[0].match_type === '^G$' && !!rs[0].match_concept && rs[0].match_code === null,
      `1 regla: tipo ^G$, por concepto, a ${CAT}`);
    const re = new RegExp(rs[0].match_concept, 'i');
    check(re.test('OSCAR CANDADO RODRIGUEZ PEREZ') && !re.test('OSCAR CANDADOZ'), 'el próximo estado de cuenta: la regex toma el nombre y no el parecido');

    console.log('\n[5] ⛔ El mismo texto hacia otra categoría: rechazado, y no queda nada a medias');
    e = await rechaza(() => svc.categorizar(String(ids.manual), { categoria: CAT_OTRA, beneficiario: 'Oscar Candado' }, POR), CategorizacionRechazada);
    check(e instanceof CategorizacionRechazada && /ya hay una regla/.test(e.message), `rechazado: «${String(e && e.message).slice(0, 70)}…»`);
    check((await leer(ids.manual)).code === null, 'el movimiento sigue vacío (la transacción se deshizo)');

    console.log('\n[6] El mismo texto y la misma categoría: reusa la regla');
    const r2 = await svc.categorizar(String(ids.manual), { categoria: CAT, beneficiario: 'Oscar Candado' }, POR);
    check(r2.regla && !r2.regla.nueva && r2.regla.prioridad === r.regla.prioridad, 'misma regla, no otra');
    check((await reglas()).length === 1 && (await leer(ids.manual)).code === CAT, 'sigue habiendo 1 regla; el movimiento quedó categorizado');

    console.log('\n[7] ⛔ Sin tenant, app_runtime no ve la regla');
    const sinTenant = await runtime.transaction(async (trx) => trx('finance.bank_classify_rules').where('note', 'like', `%${POR}%`));
    check(sinTenant.length === 0, `RLS: ${sinTenant.length} reglas visibles sin tenant`);
  } finally {
    try {
      await admin('finance.bank_classify_rules').where({ tenant_id: MEGA }).where('note', 'like', `%${POR}%`).del();
      if (ids.cuenta) await admin('finance.bank_accounts').where({ id: ids.cuenta }).del(); // cascada: estado y movimientos
      await admin('finance.movement_categories').where({ tenant_id: MEGA }).whereIn('code', [CAT, CAT_OTRA, CAT_IN]).del();
    } catch (err) {
      console.log(`  ⚠ limpieza incompleta: ${err.message}`);
    }
    await admin.destroy();
    await runtime.destroy();
  }
}

(async () => {
  const urlAdmin = process.env.DATABASE_URL_NEW;
  const urlRuntime = process.env.DATABASE_URL_NEW_RUNTIME;
  const kAdmin = classify(urlAdmin).kind;
  const kRuntime = classify(urlRuntime).kind;
  if (kAdmin === 'local' && kRuntime === 'local') await completo(urlAdmin, urlRuntime);
  else if (kAdmin === 'prod') await soloLectura(urlAdmin);
  else noMedido(`destino ${kAdmin}/${kRuntime}: ni local ni prod — no se corre`);
  fin();
})().catch((e) => {
  console.log(`  ✗ excepción: ${e && e.message}`);
  fail += 1;
  fin();
});
