/* eslint-disable no-console */
/**
 * `[LC.21]` — Candado del desglose de /contabilidad/contpaqi (balanza, bancos, proveedores SAT, CFDI
 * vs contabilidad). Sólo lectura, contra prod. Cada desglose tiene que SUMAR la cifra que abre:
 *
 *   1. ⛔ EFOS: el total es el del universo, no el de la página (decía «50» con 109).
 *   2. ⛔ Balanza: dice cuántos grupos hay (mostraba 30 de ~990 cuentas sin decirlo).
 *   3. ⭐ Balanza: cada familia = la suma de sus cuentas (el grupo → sus cuentas).
 *   4. ⭐ Balanza: los renglones de póliza de una cuenta = su balanza — y si no cuadran, el desglose
 *      lo DICE (`cuadra=false` con las dos sumas), no lo esconde.
 *   5. ⭐ Bancos: movimientos, depósitos y retiros de cada banco = su renglón; también por mes y flujo.
 *   6. ⭐ CFDI vs contabilidad: los CFDI de cada proveedor = su `num_cfdis` y su `total`.
 *   7. ⛔ Negativas: sin cuenta ni mes, o con una cuenta que no es número, se rechaza antes del SQL.
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
let ok = 0; let fail = 0; let nm = 0;
const check = (c, l) => { if (c) { ok += 1; console.log(`  ✓ ${l}`); } else { fail += 1; console.log(`  ✗ ${l}`); } };
const noMedido = (l) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${l}`); };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.21 desglose de ContPAQi: ${ok} ✓ / ${fail} ✗${nm ? ` · ${nm} NO MEDIDO` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
};
const filas = (c) => (c && c.columns ? c.data.map((row) => Object.fromEntries(c.columns.map((k, i) => [k, row[i]]))) : []);
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url || classify(url).kind !== 'prod') { noMedido('destino no es prod: los libros de ContPAQi sólo existen ahí'); return fin(); }
  const pool = knexLib({ client: 'pg', connection: url,
    pool: { min: 0, max: 3, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  try {
    const tk = { run: async (a, b) => pool.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return (typeof a === 'function' ? a : b)(trx);
    }) };
    const ctx = { requireTenantId: () => MEGA, get: () => ({ tenantId: MEGA }) };
    const { MaatToolsService } = require(path.join(ROOT, 'libs/finance/src/lib/maat/maat-tools.service.ts'));
    const { CfdiContabilidadService } = require(path.join(ROOT, 'libs/fiscal/src/lib/materialidad/cfdi-contabilidad.service.ts'));
    const svc = new MaatToolsService(tk, ctx, null, null, null); svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
    const cfdi = new CfdiContabilidadService(tk, ctx);

    console.log('\n[1] Proveedores SAT');
    const e = await svc.contpaqiEfos({});
    const { rows: [real] } = await pool.raw(`SELECT count(*)::int n, count(*) FILTER (WHERE l.lista = '69B')::int b
      FROM analytics.contpaqi_suppliers s JOIN fiscal.sat_list_rfcs l ON l.rfc = s.rfc WHERE s.tenant_id = ? AND s.rfc IS NOT NULL`, [MEGA]);
    check(e.total === real.n && e.en_69b === real.b, `⛔ el total es el del universo: ${e.total} (69B ${e.en_69b}) = ${real.n} (${real.b}) · página de ${filas(e.rows).length}`);

    console.log('\n[2-4] Balanza');
    const bc = await svc.contpaqiBalanza({ group_by: 'cuenta' });
    check(bc.total_grupos >= filas(bc.rows).length && bc.total_grupos > 0, `⛔ dice cuántas cuentas hay: ${bc.total_grupos} (la página trae ${filas(bc.rows).length})`);
    for (const f of filas((await svc.contpaqiBalanza({ group_by: 'familia' })).rows)) {
      let suma = 0; let off = 0; let tot = Infinity;
      while (off < tot) {
        const p = await svc.contpaqiBalanza({ group_by: 'cuenta', familia: f.clave, limit: 200, offset: off });
        const rs = filas(p.rows); tot = p.total_grupos; if (!rs.length) break;
        suma += rs.reduce((a, x) => a + x.cargos, 0); off += rs.length;
      }
      check(Math.abs(suma - f.cargos) < 0.05, `familia ${f.familia}: cargos ${f.cargos} = suma de sus ${tot} cuentas (${Math.round(suma * 100) / 100})`);
    }
    let cuadran = 0; let declaradas = 0;
    for (const f of filas(bc.rows).slice(0, 10)) {
      const r = await svc.contpaqiBalanzaRenglones({ cuenta: f.clave });
      const balOk = igual(r.balanza.cargos, f.cargos) && igual(r.balanza.abonos, f.abonos);
      const decl = r.cuadra === (igual(r.cargos, r.balanza.cargos) && igual(r.abonos, r.balanza.abonos));
      if (balOk && decl) { if (r.cuadra) cuadran++; else declaradas++; }
      else check(false, `${f.clave}: la balanza del desglose (${r.balanza.cargos}) no es la de la fila (${f.cargos}), o «cuadra» miente`);
    }
    check(cuadran + declaradas === 10, `las 10 cuentas más grandes: ${cuadran} cuadran renglón por renglón con su balanza, ${declaradas} no cuadran y lo DICEN`);
    // ⛔ La negativa: una cuenta que la balanza tiene con cargos y SIN ningún renglón de póliza
    // importado (medido el 2026-10-22: 36 de clientes 1050… en jul–sep). El desglose tiene que decir
    // que no cuadra, con las dos sumas — no darla por buena.
    const { rows: [sin] } = await pool.raw(
      `SELECT l.cuenta, l.anio_mes FROM analytics.contpaqi_ledger_monthly l
        WHERE l.tenant_id = ? AND l.cargos > 0 AND l.anio_mes >= to_char(now() - interval '6 months', 'YYYY-MM')
          AND NOT EXISTS (SELECT 1 FROM analytics.gl_poliza_lines g WHERE g.tenant_id = l.tenant_id AND g.source = 'contpaqi'
                           AND g.cuenta = l.cuenta AND g.anio_mes = l.anio_mes)
        ORDER BY l.cargos DESC LIMIT 1`, [MEGA]);
    if (!sin) noMedido('no hay una cuenta con balanza sin renglones en 6 meses: la negativa no tiene con qué');
    else {
      const r = await svc.contpaqiBalanzaRenglones({ cuenta: sin.cuenta, from_mes: sin.anio_mes, to_mes: sin.anio_mes });
      check(r.cuadra === false && r.renglones === 0 && r.balanza.cargos > 0,
        `⛔ ${sin.cuenta} en ${sin.anio_mes}: balanza ${r.balanza.cargos} sin renglones → el desglose dice «no cuadra» (cuadra=${r.cuadra})`);
    }

    console.log('\n[5] Bancos');
    for (const b of filas((await svc.contpaqiBanco({ group_by: 'banco' })).rows).slice(0, 3)) {
      const m = await svc.contpaqiBancoMovimientos({ cuenta: b.cuenta });
      check(m.movs === b.movs && igual(m.depositos, b.depositos) && igual(m.retiros, b.retiros),
        `${b.banco}: ${m.movs} movs = ${b.movs} · depósitos y retiros iguales al centavo`);
    }
    const ult = filas((await svc.contpaqiBanco({ group_by: 'mes' })).rows).slice(-1)[0];
    const mm = await svc.contpaqiBancoMovimientos({ mes: ult.mes, flujo: 'retiro' });
    check(igual(mm.retiros, ult.retiros) && mm.depositos === 0, `mes ${ult.mes}, sólo retiros: ${mm.retiros} = ${ult.retiros} (y 0 depósitos en lo filtrado)`);

    console.log('\n[6] CFDI vs contabilidad');
    const per = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 7);
    const o = await cfdi.overview(per);
    if (!o.rows.length) noMedido(`sin CFDI recibidos en ${per}`);
    let iguales = 0; const muestra = [...o.rows.slice(0, 8), ...o.rows.filter((x) => x.riesgo !== 'ok').slice(0, 4)];
    for (const r of muestra) {
      const d = await cfdi.cfdisDeProveedor(per, r.rfc);
      if (d.num_cfdis === r.num_cfdis && igual(d.total, r.total)) iguales++;
      else check(false, `${r.rfc}: renglón ${r.num_cfdis}/${r.total} vs desglose ${d.num_cfdis}/${d.total}`);
    }
    if (muestra.length) check(iguales === muestra.length, `${per}: los CFDI de ${iguales} de ${muestra.length} proveedores = su renglón (conteo y total)`);

    console.log('\n[7] Negativas');
    const n1 = await svc.contpaqiBancoMovimientos({}).catch((x) => x.message);
    const n2 = await svc.contpaqiBalanzaRenglones({ cuenta: "1' OR 1=1" }).catch((x) => x.message);
    const n3 = await cfdi.cfdisDeProveedor(per, 'NO-ES-RFC').catch((x) => x.message);
    check(/hace falta/.test(n1) && /cuenta inválida/.test(n2) && /RFC inválido/.test(n3), 'sin cuenta ni mes, cuenta no numérica y RFC mal formado: rechazados antes del SQL');
  } finally {
    await pool.destroy();
  }
  return fin();
})().catch((e) => { console.log(`  ✗ excepción: ${e && e.message}`); fail += 1; fin(); });
