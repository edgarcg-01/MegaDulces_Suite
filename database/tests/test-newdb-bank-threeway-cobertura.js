/* eslint-disable no-console */
/**
 * `[CP.8.89]` — Candado: en el cuadre 3 vías (`/finanzas/bancos?view=cuadre`), la cobertura de
 * ContPAQi mide el DINERO del banco que ya tiene póliza, no la fecha más alta.
 *
 * Nace del 2026-10-29: octubre decía «ContPAQi al día» porque la póliza de traspasos venía fechada
 * el 31 (consultado el 29), cuando sólo el 68.2 % del dinero del banco tenía póliza ($44.3 M sin
 * ella). La pantalla llamaba «descuadre» a lo que era captura pendiente.
 *
 * Dos modos según el destino, como `test-newdb-contpaqi-entrega.js`:
 *
 *   destino LOCAL (el job `pruebas-db` del CI) → **completo**: siembra dos meses de 2001 con
 *     importes conocidos (con `DATABASE_URL_NEW`, postgres), ejerce `threeWay` con el pool de
 *     `DATABASE_URL_NEW_RUNTIME` (`app_runtime`, RLS forzado en `finance.*`) y el tenant puesto
 *     como lo pone la API, y limpia lo sembrado. Cada control negativo da un % DISTINTO si falla,
 *     así el número dice qué se rompió.
 *
 *   destino PROD → **sólo lectura**: el mes en curso y el anterior (calculados de HOY, no escritos:
 *     un candado con la fecha adentro caduca). Cruza la consulta contra la segunda implementación
 *     que ya vive en el servicio (`contpaqiAccountDetail`, ±$1 por cuenta) y corre el placebo.
 *
 *   node database/tests/test-newdb-bank-threeway-cobertura.js
 */
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
// El servicio sólo necesita los NOMBRES de estas dos dependencias (la inyección se hace a mano
// abajo). Se registran en la caché de módulos: no se escribe ningún archivo de stub.
const STUBS = {
  '@megadulces/platform-core': { TenantKnexService: class {}, TenantContextService: class {} },
  '@megadulces/contracts': { FINANCE_FINDINGS_SINK_PORT: Symbol('findings-sink') },
};
const stubIds = {};
for (const [pedido, exportsStub] of Object.entries(STUBS)) {
  const id = path.join(__dirname, `__stub_cp889_${pedido.replace(/[@/]/g, '_')}.js`);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsStub, children: [], paths: [] };
  stubIds[pedido] = id;
}
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return stubIds[pedido] || resolveOriginal.call(this, pedido, ...resto);
};

const knexLib = require('knex');
const { classify, assertSafeTarget } = require('./_lib/assert-safe-target');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const P_COMPLETO = '2001-01';
const P_PARCIAL = '2001-02';
const CTA_A = '1020990891';
const CTA_B = '1020990892';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.89 cobertura ContPAQi: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

const hoyMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const mesAntes = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** El servicio real, con el tenant puesto como lo pone `TenantKnexService.run`. */
function servicio(pool, conTenant = true) {
  const { FinanceBankService } = require(path.join(ROOT, 'libs/finance/src/lib/bank/finance-bank.service.ts'));
  const tk = {
    run: (cb) => pool.transaction(async (trx) => {
      if (conTenant) await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]);
      return cb(trx);
    }),
  };
  const svc = new FinanceBankService(tk, { requireTenantId: () => MEGA });
  svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
  return svc;
}

/** ¿Existen las relaciones que `threeWay` lee? Sin ellas el candado no mide: se declara. */
async function faltantes(db) {
  const rels = ['finance.bank_accounts', 'finance.bank_statements', 'finance.bank_movements',
    'analytics.contpaqi_bank_movements', 'analytics.kepler_bank_movements', 'analytics.bank_postings'];
  const r = await db.raw('SELECT r FROM unnest(?::text[]) r WHERE to_regclass(r) IS NULL', [rels]);
  return r.rows.map((x) => x.r);
}

async function soloLectura(url) {
  console.log('\n[modo SÓLO LECTURA — destino prod]');
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  try {
    const hoy = hoyMx();
    const svc = servicio(pool);
    const cuentas = await pool('finance.bank_accounts').where({ tenant_id: MEGA, kind: 'bank' })
      .whereNotNull('contpaqi_cuenta').select('id', 'contpaqi_cuenta');
    for (const p of [mesAntes(hoy.slice(0, 7)), hoy.slice(0, 7)]) {
      console.log(`\n[${p}]`);
      const t0 = Date.now();
      const tw = await svc.threeWay(p);
      const ms = Date.now() - t0;
      const c = tw.coverage.contpaqi;
      console.log(`  · threeWay en ${ms} ms (ida y vuelta desde esta máquina) · ContPAQi ${c.casado_pct} % casado`);
      for (const k of ['workbook', 'kepler', 'contpaqi']) {
        const last = tw.coverage[k].last;
        check(last == null || last <= hoy, `${k}: su último día (${last}) no es posterior a hoy (${hoy})`);
      }
      if (c.casado_pct == null) { noMedido(`${p}: sin banco que casar en cuentas enlazadas`); continue; }

      // ⭐ La segunda implementación: el drill por cuenta (±$1, voraz), sumado.
      let banco = 0;
      let casado = 0;
      for (const a of cuentas) {
        const det = await svc.contpaqiAccountDetail(p, a.id);
        banco += det.deposits.bank_total + det.withdrawals.bank_total;
        casado += det.deposits.matched_amount + det.withdrawals.matched_amount;
      }
      const pct2 = banco > 0 ? Math.round((casado / banco) * 1000) / 10 : null;
      const sinPoliza = Math.round((banco - casado) * 100) / 100;
      check(Math.abs(sinPoliza - c.sin_poliza.monto) <= Math.max(1, banco * 0.005),
        `el dinero sin póliza cuadra con el drill por cuenta: $${c.sin_poliza.monto} vs $${sinPoliza} (±0.5 %)`);
      check(pct2 != null && Math.abs(pct2 - c.casado_pct) <= 0.5,
        `el % casado cuadra con el drill por cuenta: ${c.casado_pct} % vs ${pct2} % (±0.5 pp)`);
      check(c.stale === (c.casado_pct < 99), `«atrasado» sale del % casado (${c.casado_pct} % → stale=${c.stale})`);
      check(!c.stale || /captura pendiente/.test(tw.nota), 'si está atrasado, la nota lo dice como captura pendiente');

      // Placebo: la póliza de OTRA cuenta. Si el cruce por importe casara por azar, esto saldría alto.
      const plac = await pool.raw(`
        WITH c0 AS (SELECT contpaqi_cuenta cta, row_number() OVER (ORDER BY contpaqi_cuenta) rn, count(*) OVER () n
                      FROM finance.bank_accounts WHERE tenant_id = ? AND kind = 'bank' AND contpaqi_cuenta IS NOT NULL),
             rot AS (SELECT a.cta, b.cta sig FROM c0 a JOIN c0 b ON b.rn = (a.rn % a.n) + 1),
             b AS (SELECT rot.sig cta, CASE WHEN COALESCE(bm.amount_in,0) > 0 THEN 'in' ELSE 'out' END dir,
                          ROUND((COALESCE(bm.amount_in,0) + COALESCE(bm.amount_out,0)) * 100)::bigint c, bm.movement_date d
                     FROM finance.bank_movements bm
                     JOIN finance.bank_statements st ON st.id = bm.statement_id
                     JOIN finance.bank_accounts a ON a.id = bm.bank_account_id
                     JOIN rot ON rot.cta = a.contpaqi_cuenta
                    WHERE st.period = ? AND bm.deleted_at IS NULL AND a.kind = 'bank'
                      AND COALESCE(bm.amount_in,0) + COALESCE(bm.amount_out,0) > 0),
             bn AS (SELECT b.*, row_number() OVER (PARTITION BY cta, dir, c ORDER BY d) k FROM b),
             q AS (SELECT cuenta cta, CASE WHEN flujo = 'deposito' THEN 'in' ELSE 'out' END dir,
                          ROUND(importe * 100)::bigint c, count(*) n
                     FROM analytics.contpaqi_bank_movements WHERE tenant_id = ? AND anio_mes = ? AND importe > 0
                    GROUP BY 1, 2, 3)
        SELECT COALESCE(SUM(bn.c), 0)::bigint banco, COALESCE(SUM(bn.c) FILTER (WHERE bn.k <= q.n), 0)::bigint casado
          FROM bn LEFT JOIN q USING (cta, dir, c)`, [MEGA, p, MEGA, p]);
      const pb = plac.rows[0];
      const pctPlacebo = Number(pb.banco) > 0 ? Math.round((Number(pb.casado) / Number(pb.banco)) * 1000) / 10 : 0;
      check(pctPlacebo < 10, `placebo (la póliza de otra cuenta): ${pctPlacebo} % casado — el cruce no casa por azar`);
    }
    noMedido('la consulta con fixtures y el RLS de app_runtime: corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[modo COMPLETO — destino local]');
  assertSafeTarget('test-newdb-bank-threeway-cobertura', { url: urlAdmin });
  assertSafeTarget('test-newdb-bank-threeway-cobertura', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = { cuentas: [] };
  try {
    const falta = await faltantes(admin);
    if (falta.length) { noMedido(`faltan relaciones en este destino: ${falta.join(', ')}`); return; }

    console.log('\n[0] Sembrar con postgres (salta el RLS: siembra, no prueba)');
    const cuenta = async (label, cta) => {
      const [r] = await admin('finance.bank_accounts').insert({
        tenant_id: MEGA, bank: 'CANDADO', account_label: label, kind: 'bank', contpaqi_cuenta: cta,
      }).returning('id');
      const id = r.id ?? r;
      ids.cuentas.push(id);
      return id;
    };
    const A = await cuenta('CP889A', CTA_A);
    await cuenta('CP889B', CTA_B);
    const mov = async (est, fecha, entra, sale, i) => admin('finance.bank_movements').insert({
      tenant_id: MEGA, statement_id: est, bank_account_id: A, movement_date: fecha,
      client_uuid: `cp889-candado-${i}`, concept: `CANDADO CP889 ${i}`,
      amount_in: entra || null, amount_out: sale || null,
    });
    const estado = async (period) => {
      const [r] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: A, period }).returning('id');
      return r.id ?? r;
    };
    // Mes completo: un depósito, y su póliza.
    const e1 = await estado(P_COMPLETO);
    await mov(e1, '2001-01-15', 300, 0, 1);
    // Mes parcial: 570.00 en el banco; sólo 150.00 tienen su póliza.
    const e2 = await estado(P_PARCIAL);
    await mov(e2, '2001-02-03', 100, 0, 2);
    await mov(e2, '2001-02-03', 100, 0, 3);
    await mov(e2, '2001-02-04', 0, 50, 4);
    await mov(e2, '2001-02-05', 250, 0, 5);
    await mov(e2, '2001-02-07', 70, 0, 6);
    let idMov = 9088900;
    const poliza = async (cuentaCpq, anioMes, fecha, flujo, importe) => {
      idMov += 1;
      await admin('analytics.contpaqi_bank_movements').insert({
        tenant_id: MEGA, id_movimiento: idMov, cuenta: cuentaCpq, fecha, flujo, importe,
        ejercicio: 1, periodo: Number(anioMes.slice(5, 7)), anio_mes: anioMes, concepto: 'CANDADO CP889',
      });
    };
    await poliza(CTA_A, P_COMPLETO, '2001-01-15', 'deposito', 300);
    await poliza(CTA_A, P_PARCIAL, '2001-02-03', 'deposito', 100); // casa con UNO de los dos de 100
    await poliza(CTA_A, P_PARCIAL, '2001-02-04', 'retiro', 50); //    casa
    await poliza(CTA_B, P_PARCIAL, '2001-02-05', 'deposito', 250); // ⛔ otra cuenta: si casa, sale 70.2 %
    await poliza(CTA_A, P_PARCIAL, '2001-02-06', 'retiro', 100); //   ⛔ otra dirección: si casa, sale 43.9 %
    await poliza(CTA_A, '2001-03', '2001-03-01', 'deposito', 70); //  ⛔ otro mes: si casa, sale 38.6 %
    await poliza(CTA_A, P_PARCIAL, '2099-01-01', 'deposito', 999); // ⛔ fecha futura: no cuenta como «al día»
    check(true, 'sembrado: 2 cuentas · 2 meses · 6 movimientos de banco · 7 pólizas');

    const svc = servicio(runtime);

    console.log(`\n[1] ${P_COMPLETO}: todo el banco tiene póliza (control positivo)`);
    const t1 = await svc.threeWay(P_COMPLETO);
    const c1 = t1.coverage.contpaqi;
    check(c1.casado_pct === 100, `100 % casado — dio ${c1.casado_pct}`);
    check(c1.stale === false, 'no se marca atrasado');
    check(c1.sin_poliza && c1.sin_poliza.monto === 0 && c1.sin_poliza.movs === 0, 'nada sin póliza');

    console.log(`\n[2] ${P_PARCIAL}: sólo 150.00 de 570.00 tienen póliza`);
    const t2 = await svc.threeWay(P_PARCIAL);
    const c2 = t2.coverage.contpaqi;
    check(c2.casado_pct === 26.3, `26.3 % casado — dio ${c2.casado_pct} (70.2 = casó otra cuenta · 43.9 = otra dirección · 38.6 = otro mes)`);
    check(c2.sin_poliza && c2.sin_poliza.monto === 420 && c2.sin_poliza.movs === 3,
      `sin póliza: $420.00 en 3 movimientos — dio $${c2.sin_poliza && c2.sin_poliza.monto} en ${c2.sin_poliza && c2.sin_poliza.movs}`);
    check(c2.stale === true && c2.pct === 26, `atrasado, y la barra al 26 % — dio stale=${c2.stale}, pct=${c2.pct}`);
    check(c2.last === '2001-02-06', `su último día es el 06, no la póliza fechada en 2099 — dio ${c2.last}`);
    check(/26\.3 %/.test(t2.nota) && /captura pendiente/.test(t2.nota), 'la nota dice el % y que es captura pendiente');

    console.log('\n[3] Visto sin tenant, como un pool sin contexto: el RLS no deja ver el banco');
    const t3 = await servicio(runtime, false).threeWay(P_PARCIAL);
    if (t3.coverage.contpaqi.casado_pct == null) {
      check(true, 'sin tenant no hay banco que casar → lo de arriba se midió a través del RLS, como la API');
    } else {
      noMedido('el rol del CI ve `finance.*` sin tenant: el RLS no se ejerció en este destino');
    }
  } finally {
    // Limpieza con postgres: lo sembrado. Nada más.
    try {
      await admin('analytics.contpaqi_bank_movements').where({ tenant_id: MEGA }).whereIn('cuenta', [CTA_A, CTA_B]).del();
      if (ids.cuentas.length) await admin('finance.bank_accounts').whereIn('id', ids.cuentas).del(); // cascada: estados y movimientos
    } catch (e) {
      console.log(`  ⚠ limpieza incompleta: ${e.message}`);
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
