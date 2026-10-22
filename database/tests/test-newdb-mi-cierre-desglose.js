/* eslint-disable no-console */
/**
 * `[LC.21]` — Candado del desglose de «Mi cierre» (/contabilidad). Sólo lectura, contra prod. La
 * bandeja clasifica cada póliza de ContPAQi por su concepto; el desglose repite esa clasificación para
 * poder listar las pólizas, y esta prueba impide que las dos copias se separen:
 *
 *   1. ⭐ Por mes y familia: pólizas, renglones y cargos del desglose = los de la VISTA
 *      `v_contpaqi_captura_mensual` (la que manda), al centavo.
 *   2. ⭐ Las familias de un mes suman el mes entero: ninguna póliza queda fuera ni en dos familias.
 *   3. ⭐ La paginación recorre el universo.
 *   4. ⭐ Cada póliza abre su detalle (`PolizasService.detail`) y el detalle trae los renglones que la
 *      lista dice — la llave (ejercicio, periodo, tipo, folio, sucursal) es la correcta.
 *   5. ⛔ Negativas: familia y mes inválidos se rechazan antes del SQL.
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
  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.21 desglose de Mi cierre: ${ok} ✓ / ${fail} ✗${nm ? ` · ${nm} NO MEDIDO` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
};
const igual = (a, b) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) < 0.01;

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url || classify(url).kind !== 'prod') { noMedido('destino no es prod: las pólizas de ContPAQi sólo existen ahí'); return fin(); }
  const pool = knexLib({ client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  try {
    const tk = { run: async (a, b) => pool.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return (typeof a === 'function' ? a : b)(trx);
    }) };
    const ctx = { requireTenantId: () => MEGA, get: () => ({ tenantId: MEGA }) };
    const { MiCierreService } = require(path.join(ROOT, 'libs/finance/src/lib/contpaqi/mi-cierre.service.ts'));
    const { PolizasService } = require(path.join(ROOT, 'libs/finance/src/lib/polizas/polizas.service.ts'));
    const svc = new MiCierreService(tk, ctx);
    const pol = new PolizasService(tk, ctx);

    const { rows: vista } = await pool.raw(
      `SELECT anio_mes, familia, polizas, renglones, cargos
         FROM analytics.v_contpaqi_captura_mensual
        WHERE tenant_id = ? AND anio_mes >= to_char(now() - interval '3 months', 'YYYY-MM')
        ORDER BY anio_mes DESC, orden`, [MEGA]);
    if (!vista.length) { noMedido('la vista no tiene meses recientes'); return fin(); }

    console.log(`\n[1] Desglose = vista, ${new Set(vista.map((v) => v.anio_mes)).size} meses`);
    let malas = 0;
    for (const v of vista) {
      const r = await svc.polizas({ mes: v.anio_mes, familia: v.familia });
      if (r.polizas !== Number(v.polizas) || r.renglones !== Number(v.renglones) || !igual(r.cargos, v.cargos)) {
        malas += 1;
        check(false, `${v.anio_mes} ${v.familia}: desglose ${r.polizas}/${r.renglones}/${r.cargos} ≠ vista ${v.polizas}/${v.renglones}/${v.cargos}`);
      }
    }
    check(malas === 0, `${vista.length - malas} de ${vista.length} celdas: pólizas, renglones y cargos iguales a la vista`);

    console.log('\n[2] Las familias suman el mes');
    const mes = vista[0].anio_mes;
    const { rows: [tot] } = await pool.raw(
      `SELECT count(*)::int n, COALESCE(sum(num_lines), 0)::int r FROM analytics.gl_polizas
        WHERE tenant_id = ? AND source = 'contpaqi' AND anio_mes = ?`, [MEGA, mes]);
    let n = 0; let rr = 0;
    for (const v of vista.filter((x) => x.anio_mes === mes)) { const r = await svc.polizas({ mes, familia: v.familia }); n += r.polizas; rr += r.renglones; }
    check(n === tot.n && rr === tot.r, `${mes}: ${n} pólizas / ${rr} renglones en las familias = ${tot.n} / ${tot.r} del mes`);

    console.log('\n[3] Paginación');
    const grande = vista.filter((v) => Number(v.polizas) > 100).sort((a, b) => Number(a.polizas) - Number(b.polizas))[0];
    if (!grande) noMedido('ninguna familia pasa de 100 pólizas en un mes: la paginación no se ejerció');
    else {
      let k = 0; let ren = 0; let car = 0; let page = 1; let total = Infinity;
      while (k < total && page < 100) {
        const r = await svc.polizas({ mes: grande.anio_mes, familia: grande.familia, page });
        total = r.polizas; if (!r.filas.length) break;
        k += r.filas.length; ren += r.filas.reduce((a, x) => a + x.renglones, 0); car += r.filas.reduce((a, x) => a + x.cargos, 0); page += 1;
      }
      check(k === Number(grande.polizas) && ren === Number(grande.renglones) && igual(car, grande.cargos),
        `${grande.anio_mes} ${grande.familia}: ${page - 1} páginas → ${k} pólizas / ${ren} renglones / ${Math.round(car * 100) / 100} = la vista`);
    }

    console.log('\n[4] Cada póliza abre su detalle');
    const muestra = [];
    for (const v of vista.filter((x) => x.anio_mes === mes && Number(x.polizas) > 0)) {
      const r = await svc.polizas({ mes, familia: v.familia });
      muestra.push(...r.filas.slice(0, 2));
    }
    let abren = 0;
    for (const f of muestra) {
      const d = await pol.detail({ source: 'contpaqi', ejercicio: f.ejercicio, periodo: f.periodo, tipo_pol: f.tipo_pol, folio: f.folio, sucursal: f.sucursal ?? undefined });
      if (d.header && d.lines.length === f.renglones) abren += 1;
      else check(false, `${f.tipo_pol}-${f.folio} (suc ${f.sucursal}): el detalle trae ${d.header ? d.lines.length : 'NADA'} renglones, la lista dice ${f.renglones}`);
    }
    if (!muestra.length) noMedido(`${mes} sin pólizas`);
    else check(abren === muestra.length, `${abren} de ${muestra.length} pólizas abren su detalle con los renglones que dice la lista`);

    console.log('\n[5] Negativas');
    const n1 = await svc.polizas({ mes, familia: 'activo' }).catch((x) => x.message);
    const n2 = await svc.polizas({ mes: '2026-13', familia: 'nomina' }).catch((x) => x.message);
    check(/familia inválida/.test(n1) && /mes inválido/.test(n2), 'familia fuera del catálogo y mes 13: rechazados antes del SQL');
  } finally {
    await pool.destroy();
  }
  return fin();
})().catch((e) => { console.log(`  ✗ excepción: ${e && e.message}`); fail += 1; fin(); });
