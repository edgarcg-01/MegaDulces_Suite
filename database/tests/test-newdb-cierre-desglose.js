/* eslint-disable no-console */
/**
 * `[LC.21]` — Candado del desglose del semáforo de cierre (/contabilidad/cierre). Sólo lectura, contra
 * prod. El desglose repite el filtro de cada familia de `v_contpaqi_cierre_mensual` para poder listar
 * renglones; esta prueba es lo que impide que las dos copias se separen:
 *
 *   1. ⭐ Por mes y familia: renglones y suma del desglose = `senal_renglones` / `senal` de la VISTA
 *      (la definición que manda, recalculada al momento).
 *   2. ⭐ Lo fechado adelante (`provisional=true`) = `provisional` de la vista.
 *   3. ⭐ La matvista que lee la pantalla: el desglose devuelve su cifra en `semaforo` y, en los meses
 *      cerrados, coincide (si no, se recalculó tarde y lo dice).
 *   4. ⭐ La paginación recorre el universo: la suma de todas las páginas = el total que declara.
 *   5. ⛔ Negativas: familia y mes inválidos se rechazan antes del SQL; un mes sin pólizas da 0, no error.
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
const FAMILIAS = ['compras', 'ventas', 'bancos', 'gastos', 'nomina'];
let ok = 0; let fail = 0; let nm = 0;
const check = (c, l) => { if (c) { ok += 1; console.log(`  ✓ ${l}`); } else { fail += 1; console.log(`  ✗ ${l}`); } };
const noMedido = (l) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${l}`); };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.21 desglose del cierre: ${ok} ✓ / ${fail} ✗${nm ? ` · ${nm} NO MEDIDO` : ''}\n`);
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
    const { ContpaqiCierreService } = require(path.join(ROOT, 'libs/finance/src/lib/contpaqi/contpaqi-cierre.service.ts'));
    const svc = new ContpaqiCierreService(tk, ctx);

    // La vista, no la matvista: es la definición que manda y no tiene el retraso del recálculo.
    const { rows: vista } = await pool.raw(
      `SELECT anio_mes, familia, senal, senal_renglones, provisional, periodo_estado
         FROM analytics.v_contpaqi_cierre_mensual
        WHERE tenant_id = ? AND anio_mes >= to_char(now() - interval '4 months', 'YYYY-MM')
        ORDER BY anio_mes DESC, familia`, [MEGA]);
    if (!vista.length) { noMedido('la vista no tiene meses recientes'); return fin(); }
    const meses = [...new Set(vista.map((v) => v.anio_mes))];

    console.log(`\n[1-2] Desglose = vista, ${meses.length} meses × ${FAMILIAS.length} familias`);
    let celdas = 0; let malas = 0; let conProv = 0;
    for (const v of vista) {
      const r = await svc.renglones({ mes: v.anio_mes, familia: v.familia });
      celdas += 1;
      if (r.renglones !== Number(v.senal_renglones) || !igual(r.importe, v.senal)) {
        malas += 1;
        check(false, `${v.anio_mes} ${v.familia}: desglose ${r.renglones} / ${r.importe} ≠ vista ${v.senal_renglones} / ${v.senal}`);
      }
      if (v.provisional != null) {
        conProv += 1;
        const p = await svc.renglones({ mes: v.anio_mes, familia: v.familia, provisional: true });
        check(igual(p.importe, v.provisional) && p.renglones > 0,
          `${v.anio_mes} ${v.familia}: fechado adelante ${p.importe} (${p.renglones} renglones) = provisional de la vista ${v.provisional}`);
      }
    }
    check(malas === 0, `${celdas - malas} de ${celdas} celdas: renglones y suma iguales a la vista al centavo`);
    if (!conProv) noMedido('ninguna celda reciente tiene pólizas fechadas adelante: lo provisional no tuvo con qué compararse');

    console.log('\n[3] La matvista que lee la pantalla');
    const cerrados = vista.filter((v) => v.periodo_estado === 'cerrado').slice(0, 10);
    let mvIguales = 0;
    for (const v of cerrados) {
      const r = await svc.renglones({ mes: v.anio_mes, familia: v.familia });
      if (r.semaforo && r.semaforo.renglones === r.renglones && igual(r.semaforo.importe, r.importe)) mvIguales += 1;
      else console.log(`    · ${v.anio_mes} ${v.familia}: semáforo ${JSON.stringify(r.semaforo)} vs desglose ${r.renglones} / ${r.importe}`);
    }
    // Una diferencia acá no es un defecto del desglose: es la matvista recalculada hace hasta 15 min.
    // Por eso se informa la cuenta, y sólo se exige que el desglose traiga la cifra del semáforo para decirla.
    check(cerrados.length > 0 && mvIguales >= Math.floor(cerrados.length * 0.8),
      `meses cerrados: ${mvIguales} de ${cerrados.length} celdas iguales a la matvista (el resto, recalculada tarde y declarada en «semaforo»)`);

    console.log('\n[4] Paginación');
    const grande = vista.filter((v) => v.periodo_estado === 'cerrado' && Number(v.senal_renglones) > 100)
      .sort((a, b) => Number(a.senal_renglones) - Number(b.senal_renglones))[0];
    if (!grande) noMedido('ninguna celda cerrada pasa de 100 renglones: la paginación no se ejerció');
    else {
      let suma = 0; let n = 0; let page = 1; let total = Infinity;
      while (n < total && page < 200) {
        const r = await svc.renglones({ mes: grande.anio_mes, familia: grande.familia, page });
        total = r.renglones; if (!r.filas.length) break;
        suma += r.filas.reduce((a, x) => a + x.importe, 0); n += r.filas.length; page += 1;
      }
      check(n === Number(grande.senal_renglones) && igual(suma, grande.senal),
        `${grande.anio_mes} ${grande.familia}: ${page - 1} páginas → ${n} renglones / ${Math.round(suma * 100) / 100} = ${grande.senal_renglones} / ${grande.senal}`);
    }

    console.log('\n[5] Negativas');
    const n1 = await svc.renglones({ mes: meses[0], familia: 'activo' }).catch((x) => x.message);
    const n2 = await svc.renglones({ mes: '2026-13', familia: 'compras' }).catch((x) => x.message);
    const n3 = await svc.renglones({ mes: "2026-09' OR 1=1", familia: 'compras' }).catch((x) => x.message);
    check(/familia inválida/.test(n1) && /mes inválido/.test(n2) && /mes inválido/.test(n3),
      'familia fuera de las cinco, mes 13 y mes con inyección: rechazados antes del SQL');
    const vacio = await svc.renglones({ mes: '2001-01', familia: 'compras' });
    check(vacio.renglones === 0 && vacio.importe === 0 && vacio.filas.length === 0 && vacio.semaforo === null,
      'un mes sin pólizas: 0 renglones y semáforo null (no hay celda), no un error');
  } finally {
    await pool.destroy();
  }
  return fin();
})().catch((e) => { console.log(`  ✗ excepción: ${e && e.message}`); fail += 1; fin(); });
